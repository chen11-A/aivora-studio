import { createHash } from "node:crypto";
import type { OAuthManager } from "../auth/auth-manager";
import { completeChatGptResponsesText } from "../auth/chatgpt-oauth";
import { GROK_API } from "../auth/grok-oauth";
import {
  DEFAULT_GEMINI_DIRECTOR_MAX_OUTPUT_TOKENS,
  runGeminiDirectorChatWithUsage,
  type GeminiTokenUsage,
} from "../providers/gemini-official-adapter";
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
import { estimateTextUsageCents } from "./budget-pricing";

export type BudgetedTextCallResult =
  | { ok: true; rawText: string; providerSummary: string; ledgerId?: string; usage?: GeminiTokenUsage | null }
  | { ok: false; budgetBlocked?: boolean; message: string };

/**
 * Upfront headroom check for multi-scene director splits so a project budget cap
 * blocks the entire batch BEFORE firing Scene 1 rather than spending partial funds.
 */
export function checkMultiCallTextBudgetHeadroom(
  deps: { projects: ProjectStore; globalConfig: GlobalConfigStore },
  input: { projectId: string; promptLengths: number[]; purposeLabel: string; maxOutputTokens?: number },
): { ok: true; totalQuotedCents: number } | { ok: false; budgetBlocked: true; message: string } {
  const snap = deps.globalConfig.getSnapshot();
  const binding = snap.routing.script;
  if (!binding || binding.source === "oauth" || input.promptLengths.length === 0) {
    return { ok: true, totalQuotedCents: 0 };
  }
  const maxOut = Math.max(256, Math.round(input.maxOutputTokens ?? DEFAULT_GEMINI_DIRECTOR_MAX_OUTPUT_TOKENS));
  const totalQuotedCents = input.promptLengths.reduce(
    (sum, len) =>
      sum +
      quotePaidAction({ kind: "text", modelId: binding.modelId, inputChars: len, maxOutputTokens: maxOut }).quotedCents,
    0,
  );
  const summary = deps.projects.withProjectDb(input.projectId, (db) =>
    getProjectBudgetSummary(db, input.projectId),
  );
  if (summary.maxBudgetCents > 0 && summary.remainingCents !== null && summary.remainingCents < totalQuotedCents) {
    return {
      ok: false,
      budgetBlocked: true,
      message: `作品预算上限拦截：${input.purposeLabel}共需 ${input.promptLengths.length} 次文本模型请求（按输出上限 ${maxOut} tokens 预估 $${(totalQuotedCents / 100).toFixed(2)}），超过当前剩余预算 $${(summary.remainingCents / 100).toFixed(2)}，已拦截发送。请在「模型中心」调整作品预算上限后重试。`,
    };
  }
  return { ok: true, totalQuotedCents };
}

/**
 * F16 unified paid text-model entrypoint for Director split & Action polish:
 * - Routes all API-key text model calls (`gemini-official`, `openai-chat`, etc.) strictly
 *   through SQLite `budget_ledger` (atomic reserve before dispatch -> usage-reconciled settlement).
 * - Enforces explicit `max_output_tokens` on Gemini requests and reconciles returned token usage
 *   (including thinking tokens) against the ledger so subsequent calls honor real consumption.
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
    maxOutputTokens?: number;
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

  const maxOutputTokens = Math.max(
    256,
    Math.round(input.maxOutputTokens ?? DEFAULT_GEMINI_DIRECTOR_MAX_OUTPUT_TOKENS),
  );
  const quote = quotePaidAction({
    kind: "text",
    modelId: binding.modelId,
    inputChars: input.systemPrompt.length + input.userPrompt.length,
    maxOutputTokens,
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
        maxOutputTokens,
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

  let settledOnServer = false;
  try {
    deps.projects.withProjectDb(input.projectId, (db) => markBudgetEntryDispatched(db, ledgerId));
    let rawText = "";
    let usage: GeminiTokenUsage | null = null;
    if (creds.view.protocol === "gemini-official") {
      const gemRes = await runGeminiDirectorChatWithUsage(
        {
          baseUrl: creds.view.baseUrl,
          apiKey: creds.apiKey,
          modelId: binding.modelId,
          systemPrompt: input.systemPrompt,
          userPrompt: input.userPrompt,
          maxOutputTokens,
        },
        deps.fetcher,
      );
      rawText = gemRes.text;
      usage = gemRes.usage;
      if (usage) {
        const resolvedUsage = usage;
        const reconciledCents = estimateTextUsageCents({ modelId: binding.modelId, ...resolvedUsage });
        deps.projects.withProjectDb(input.projectId, (db) =>
          settleBudgetEntry(db, ledgerId, "succeeded", {
            reconciledEstimatedCents: reconciledCents,
            note: `实测用量 in=${resolvedUsage.inputTokens} out=${resolvedUsage.outputTokens} thought=${resolvedUsage.thoughtTokens}（上限 ${maxOutputTokens}，按费率校对暂估 $${(reconciledCents / 100).toFixed(2)}，以账单为准）`,
          }),
        );
      } else {
        deps.projects.withProjectDb(input.projectId, (db) =>
          settleBudgetEntry(db, ledgerId, "unknown", {
            note: `远端已返回但未附带 token 用量（待核对，保留保守预留 $${(quote.quotedCents / 100).toFixed(2)}，不按零费用或已实扣记账）`,
          }),
        );
      }
      settledOnServer = true;
      if (!rawText) {
        throw new Error(
          gemRes.status === "incomplete"
            ? `Gemini 输出达到上限（${maxOutputTokens} tokens）未返回完整文本，实际用量已计入账本`
            : "Gemini 未返回剧本拆镜文本",
        );
      }
    } else {
      rawText = await runOpenAiChatCompletion(
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
      settledOnServer = true;
    }
    return {
      ok: true,
      rawText,
      providerSummary: `${creds.view.name} · ${binding.modelId}`,
      ledgerId,
      usage,
    };
  } catch (err) {
    if (!settledOnServer) {
      const detail = err instanceof Error ? err.message : String(err);
      const isAmbiguous =
        err instanceof AmbiguousRemoteError ||
        /timeout|timed out|abort|504|ECONNRESET|ETIMEDOUT|fetch failed/i.test(detail);
      deps.projects.withProjectDb(input.projectId, (db) =>
        settleBudgetEntry(db, ledgerId, isAmbiguous ? "unknown" : "failed"),
      );
    }
    throw err;
  }
}
