import { createHash } from "node:crypto";
import type { ProjectWorkspace } from "../../shared/types/domain";
import { AmbiguousRemoteError } from "../providers/kling-adapter";
import { runGeminiMusicGeneration } from "../providers/gemini-official-adapter";
import type { GlobalConfigStore } from "../storage/global-store";
import type { ProjectStore } from "../storage/project-store";
import {
  authorizeAndReserveBudget,
  markBudgetEntryDispatched,
  quotePaidAction,
  settleBudgetEntry,
} from "./budget-ledger";

export type GenerateProjectBgmResult = {
  ok: boolean;
  projectId: string;
  status?: "succeeded" | "failed" | "unknown";
  ledgerId?: string;
  candidateAssetId?: string;
  candidateMediaPath?: string;
  modelId?: string;
  workspace?: ProjectWorkspace;
  message: string;
};

export type BgmRunner = typeof runGeminiMusicGeneration;

/**
 * F16: Unified paid Lyria BGM entrypoint routed strictly through SQLite `budget_ledger`:
 * - Atomic `BEGIN IMMEDIATE` budget-cap & cross-window duplicate guard before any network call.
 * - If remote music generation succeeds but local DB/disk registration fails, transitions ledger to
 *   `unknown_hold` (NEVER releases reservation to 0 or allows blind re-charge!).
 */
export async function generateProjectBgmWithBudget(
  deps: {
    projects: ProjectStore;
    globalConfig: GlobalConfigStore;
    musicRunner?: BgmRunner;
  },
  input: { projectId: string; prompt: string; approvalId?: string },
): Promise<GenerateProjectBgmResult> {
  const snap = deps.globalConfig.getSnapshot();
  const gemini = snap.providers.find(
    (p) => p.protocol === "gemini-official" && p.enabled && p.hasSecret,
  );
  if (!gemini) {
    return {
      ok: false,
      projectId: input.projectId,
      status: "failed",
      message: "请先在「模型中心」保存一个 Google Gemini 官方全家桶 API Key，即可生成 Lyria 候选配乐。",
    };
  }
  const creds = deps.globalConfig.getProviderCredentials(gemini.id);
  if (!creds?.apiKey) {
    return {
      ok: false,
      projectId: input.projectId,
      status: "failed",
      message: "Gemini API Key 不可用，请在模型中心重新保存。",
    };
  }
  const projectDir = deps.projects.resolveProjectDir(input.projectId);
  if (!projectDir) {
    return { ok: false, projectId: input.projectId, status: "failed", message: "作品目录不存在" };
  }

  const musicModel = gemini.models.find((m) => /lyria/i.test(m)) ?? "lyria-3.5";
  const normalizedPrompt =
    input.prompt.trim() || "warm cinematic background music, gentle piano and strings";
  const inputSha256 = createHash("sha256")
    .update(JSON.stringify({ kind: "music", projectId: input.projectId, modelId: musicModel, prompt: normalizedPrompt }))
    .digest("hex");

  const quote = quotePaidAction({ kind: "music", modelId: musicModel });
  let ledgerId: string;
  try {
    const entry = deps.projects.withProjectDb(input.projectId, (db) =>
      authorizeAndReserveBudget(db, {
        projectId: input.projectId,
        kind: "music",
        quotedCents: quote.quotedCents,
        approvalId: input.approvalId,
        inputSha256,
        providerLabel: gemini.name,
        modelId: musicModel,
        note: `Lyria 配乐：${normalizedPrompt.slice(0, 80)}`,
      }),
    );
    ledgerId = entry.id;
  } catch (err) {
    return {
      ok: false,
      projectId: input.projectId,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let remoteSucceeded = false;
  const runner = deps.musicRunner ?? runGeminiMusicGeneration;
  try {
    deps.projects.withProjectDb(input.projectId, (db) =>
      markBudgetEntryDispatched(db, ledgerId),
    );
    const media = await runner({
      baseUrl: creds.view.baseUrl,
      apiKey: creds.apiKey,
      modelId: musicModel,
      prompt: normalizedPrompt,
      projectDir,
    });
    remoteSucceeded = true;

    const stamp = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const { assetId, workspace } = deps.projects.registerProjectBgmCandidate({
      projectId: input.projectId,
      name: `AI 候选配乐 · ${musicModel} (${stamp})`,
      mediaPath: media.mediaPath,
      mediaSha256: media.mediaSha256,
      description: normalizedPrompt.slice(0, 120) || "Lyria AI 候选配乐（待试听）",
    });

    deps.projects.withProjectDb(input.projectId, (db) =>
      settleBudgetEntry(db, ledgerId, "succeeded"),
    );

    return {
      ok: true,
      projectId: input.projectId,
      status: "succeeded",
      ledgerId,
      candidateAssetId: assetId,
      candidateMediaPath: media.mediaPath,
      modelId: musicModel,
      workspace,
      message: `已通过 ${musicModel} 生成并登记候选配乐（未覆盖当前配乐，重启或清理缓存也不会丢失）`,
    };
  } catch (err) {
    const isUnknown = remoteSucceeded || err instanceof AmbiguousRemoteError;
    const rawMsg = err instanceof Error ? err.message : String(err);
    const msg = remoteSucceeded
      ? `远端配乐已生成，但本地保存/入库失败，已转入 UNKNOWN 防重复扣费：${rawMsg}`
      : `AI 配乐生成失败：${rawMsg}`;
    deps.projects.withProjectDb(input.projectId, (db) =>
      settleBudgetEntry(db, ledgerId, isUnknown ? "unknown" : "failed", { note: msg }),
    );
    return {
      ok: false,
      projectId: input.projectId,
      status: isUnknown ? "unknown" : "failed",
      ledgerId,
      message: msg,
    };
  }
}
