import { createHash } from "node:crypto";
import type { OAuthManager } from "../auth/auth-manager";
import { completeChatGptResponsesText } from "../auth/chatgpt-oauth";
import { GROK_API } from "../auth/grok-oauth";
import { runGeminiDirectorChat } from "../providers/gemini-official-adapter";
import { AmbiguousRemoteError } from "../providers/kling-adapter";
import { runOpenAiChatCompletion } from "../providers/openai-compat-adapter";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";
import {
  authorizeAndReserveBudget,
  getProjectBudgetSummary,
  markBudgetEntryDispatched,
  quotePaidAction,
  settleBudgetEntry,
} from "./budget-ledger";

export type BudgetedTextCallResult =
  | { ok: true; rawText: string; providerSummary: string; ledgerId?: string }
  | { ok: false; budgetBlocked?: boolean; message: string };

/**
 * Upfront headroom check for multi-scene director splits so a project budget cap
 * blocks the entire batch BEFORE firing Scene 1 rather than spending partial funds.
 */
export function checkMultiCallTextBudgetHeadroom(
  deps: { projects: ProjectStore; globalConfig: GlobalConfigStore },
  input: { projectId: string; promptLengths: number[]; purposeLabel: string },
): { ok: true; totalQuotedCents: number } | { ok: false; budgetBlocked: true; message: string } {
  const snap = deps.globalConfig.getSnapshot();
  const binding = snap.routing.script;
  if (!binding || binding.source === "oauth" || input.promptLengths.length === 0) {
    return { ok: true, totalQuotedCents: 0 };
  }
  const totalQuotedCents = input.promptLengths.reduce(
    (sum, len) => sum + quotePaidAction({ kind: "text", modelId: binding.modelId, inputChars: len }).quotedCents,
    0,
  );
  const summary = deps.projects.withProjectDb(input.projectId, (db) =>
    getProjectBudgetSummary(db, input.projectId),
  );
  if (summary.maxBudgetCents > 0 && summary.remainingCents !== null && summary.remainingCents < totalQuotedCents) {
    return {
      ok: false,
      budgetBlocked: true,
      message: `作品预算上限拦截：${input.purposeLabel}共需 ${input.promptLengths.length} 次文本模型请求（预估 $${(totalQuotedCents / 100).toFixed(2)}），超过当前剩余预算 $${(summary.remainingCents / 100).toFixed(2)}，已拦截发送。请在「模型中心」调整作品预算上限后重试。`,
    };
  }
  return { ok: true, totalQuotedCents };
}

/**
 * F16 unified paid text-model entrypoint for Director split & Action polish:
 * - Routes all API-key text model calls (`gemini-official`, `openai-chat`, etc.) strictly
 *   through SQLite `budget_ledger` (atomic reserve before dispatch -> settle_estimated / release / unknown_hold).
 * - Prevents director split (including multi-scene loops) and action polish from bypassing project budget caps.
 */
export async function runBudgetedTextModelCall(
  deps: {
    projects: ProjectStore;
    globalConfig: GlobalConfigStore;
    oauth: OAuthManager;
    fetcher: typeof fetch;
  },
  input: {
    projectId: string;
    shotId?: string | null;
    purpose: string;
    systemPrompt: string;
    userPrompt: string;
  },
): Promise<BudgetedTextCallResult> {
  const snap = deps.globalConfig.getSnapshot();
  const binding = snap.routing.script;
  if (!binding) {
    return { ok: false, message: "未配置剧本模型" };
  }

  if (binding.source === "oauth") {
    const token = await deps.oauth.getValidAccessToken(
      binding.sourceId as "chatgpt-web" | "grok-web",
    );
    if (binding.sourceId === "chatgpt-web") {
      const rawText = await completeChatGptResponsesText(
        {
          model: binding.modelId,
          text: input.userPrompt,
          instructions: input.systemPrompt,
          accessToken: token,
        },
        deps.fetcher,
      );
      return { ok: true, rawText, providerSummary: `ChatGPT 网页账号 · ${binding.modelId}` };
    }
    const rawText = await runOpenAiChatCompletion(
      {
        baseUrl: GROK_API,
        apiKey: token,
        modelId: binding.modelId,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
      },
      deps.fetcher,
    );
    return { ok: true, rawText, providerSummary: `Grok (xAI) · ${binding.modelId}` };
  }

  const creds = deps.globalConfig.getProviderCredentials(binding.sourceId);
  if (!creds || !creds.apiKey) {
    return { ok: false, message: "所选剧本厂家缺少可用 API Key，请在模型中心补全" };
  }

  const quote = quotePaidAction({
    kind: "text",
    modelId: binding.modelId,
    inputChars: input.systemPrompt.length + input.userPrompt.length,
  });
  const inputSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        kind: "text",
        projectId: input.projectId,
        shotId: input.shotId ?? null,
        purpose: input.purpose,
        providerId: binding.sourceId,
        modelId: binding.modelId,
        userPrompt: input.userPrompt,
      }),
    )
    .digest("hex");

  let ledgerId: string;
  try {
    const entry = deps.projects.withProjectDb(input.projectId, (db) =>
      authorizeAndReserveBudget(db, {
        projectId: input.projectId,
        shotId: input.shotId ?? null,
        kind: "text",
        quotedCents: quote.quotedCents,
        inputSha256,
        providerLabel: creds.view.name,
        modelId: binding.modelId,
        note: input.purpose.slice(0, 100),
      }),
    );
    ledgerId = entry.id;
  } catch (err) {
    return {
      ok: false,
      budgetBlocked: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    deps.projects.withProjectDb(input.projectId, (db) => markBudgetEntryDispatched(db, ledgerId));
    const rawText =
      creds.view.protocol === "gemini-official"
        ? await runGeminiDirectorChat(
            {
              baseUrl: creds.view.baseUrl,
              apiKey: creds.apiKey,
              modelId: binding.modelId,
              systemPrompt: input.systemPrompt,
              userPrompt: input.userPrompt,
            },
            deps.fetcher,
          )
        : await runOpenAiChatCompletion(
            {
              baseUrl: creds.view.baseUrl,
              apiKey: creds.apiKey,
              modelId: binding.modelId,
              systemPrompt: input.systemPrompt,
              userPrompt: input.userPrompt,
            },
            deps.fetcher,
          );
    deps.projects.withProjectDb(input.projectId, (db) =>
      settleBudgetEntry(db, ledgerId, "succeeded"),
    );
    return {
      ok: true,
      rawText,
      providerSummary: `${creds.view.name} · ${binding.modelId}`,
      ledgerId,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const isAmbiguous =
      err instanceof AmbiguousRemoteError ||
      /timeout|timed out|abort|504|ECONNRESET|ETIMEDOUT|fetch failed/i.test(detail);
    deps.projects.withProjectDb(input.projectId, (db) =>
      settleBudgetEntry(db, ledgerId, isAmbiguous ? "unknown" : "failed"),
    );
    throw err;
  }
}
