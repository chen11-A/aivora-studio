import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { buildSpeechSnapshot } from "../../shared/media-selection";
import type { GenerationPlan, LockedGenerationInput } from "../../shared/types/jobs";
import { resolveConfinedMediaPath } from "../media/media-protocol";
import {
  downloadVerifiedComfyVideo,
  pollAndDownloadComfyWorkerVideo,
  queryComfyWorkerVideo,
  runComfyWorkerImage,
  submitComfyWorkerVideo,
} from "../providers/comfy-worker-adapter";
import {
  downloadVerifiedGeminiVideo,
  pollAndDownloadGeminiVideo,
  queryGeminiVideoTask,
  runGeminiImageGeneration,
  runGeminiSpeechSynthesis,
  submitGeminiVideoTask,
} from "../providers/gemini-official-adapter";
import {
  pollAndDownloadGrokVideo,
  queryGrokVideoTask,
  submitGrokVideoTask,
} from "../providers/grok-video-adapter";
import {
  downloadVerifiedKlingMp4,
  pollAndDownloadKlingVideo,
  queryKlingVideoTask,
  submitKlingVideoTask,
} from "../providers/kling-adapter";
import {
  runOpenAiImageGeneration,
  runOpenAiSpeechSynthesis,
} from "../providers/openai-compat-adapter";
import { prepareReferenceImageForUpload } from "../providers/ref-image-injector";
import {
  pollAndDownloadSeedanceVideo,
  querySeedanceVideoTask,
  submitSeedanceVideoTask,
} from "../providers/seedance-adapter";
import type { LockedProviderSnapshot } from "./job-persistence";

export type ResolvedCredentials = {
  apiKey: string;
  secondaryKey: string | null;
  trustedBaseUrl: string;
};

export type DispatchedJobOutcome =
  | { target: "asset-portrait"; media: { mediaPath: string; mediaSha256: string }; message: string }
  | {
      target: "shot-take";
      kind: "image" | "video" | "speech";
      media: { mediaPath: string; mediaSha256: string };
      message: string;
      promptSnapshotOverride?: string;
    };

async function loadSingleReferenceImage(
  projectDir: string,
  mediaPath: string,
  expectedSha256: string | null,
): Promise<{ base64: string; mime: "image/png" | "image/jpeg" | "image/webp"; compressed: boolean }> {
  const absPath = resolveConfinedMediaPath(projectDir, mediaPath);
  if (!absPath || !existsSync(absPath)) {
    throw new Error(
      "已确认的首帧或参考图文件已不存在，已拦截发送以避免降级为无参考图扣费，请重新确认后再生成。",
    );
  }
  if (expectedSha256) {
    const actualSha = createHash("sha256").update(readFileSync(absPath)).digest("hex");
    if (actualSha !== expectedSha256) {
      throw new Error("已确认的首帧或参考图文件内容已变化，已拦截发送，请重新确认后再生成。");
    }
  }
  const prepared = await prepareReferenceImageForUpload(absPath);
  if (!prepared) {
    throw new Error("参考图文件无法读取，已拦截发送。");
  }
  return prepared;
}

async function loadLockedReferenceImage(
  projectDir: string,
  locked: LockedGenerationInput,
): Promise<{ base64: string; mime: "image/png" | "image/jpeg" | "image/webp"; compressed: boolean } | null> {
  if (!locked.referenceMediaPath) return null;
  return loadSingleReferenceImage(projectDir, locked.referenceMediaPath, locked.referenceMediaSha256);
}

async function loadLockedReferenceImages(
  projectDir: string,
  locked: LockedGenerationInput,
): Promise<Array<{ base64: string; mime: "image/png" | "image/jpeg" | "image/webp"; label: string }>> {
  const items = locked.referenceItems ?? [];
  if (items.length === 0) {
    const single = await loadLockedReferenceImage(projectDir, locked);
    return single ? [{ base64: single.base64, mime: single.mime, label: "reference" }] : [];
  }
  const out: Array<{ base64: string; mime: "image/png" | "image/jpeg" | "image/webp"; label: string }> = [];
  for (const item of items) {
    const loaded = await loadSingleReferenceImage(projectDir, item.mediaPath, item.mediaSha256);
    out.push({ base64: loaded.base64, mime: loaded.mime, label: item.label });
  }
  return out;
}

export async function dispatchGenerationJob(ctx: {
  plan: GenerationPlan;
  projectDir: string;
  snapshot: LockedProviderSnapshot;
  creds: ResolvedCredentials;
  fetcher: typeof fetch;
  pollIntervalMs: number;
  maxPollRounds: number;
  onUpdateJob: (patch: {
    remoteTaskId?: string;
    providerSnapshot?: string;
    progress?: number;
  }) => void;
}): Promise<DispatchedJobOutcome> {
  const { plan, projectDir, snapshot, creds, fetcher, pollIntervalMs, maxPollRounds, onUpdateJob } = ctx;
  const locked = plan.lockedInput;

  // 1. Asset portrait candidate generation
  if (plan.assetId && plan.kind === "image") {
    const baseInput = {
      baseUrl: creds.trustedBaseUrl,
      apiKey: creds.apiKey,
      modelId: snapshot.modelId,
      prompt: locked.finalPrompt,
      aspectRatio: locked.aspectRatio,
      projectDir,
    };
    const media =
      snapshot.protocol === "gemini-official"
        ? await runGeminiImageGeneration(baseInput, fetcher)
        : snapshot.protocol === "comfy-worker"
          ? await runComfyWorkerImage(baseInput, fetcher)
          : await runOpenAiImageGeneration(baseInput, fetcher);
    return {
      target: "asset-portrait",
      media,
      message: "定妆候选图已生成（未替换已确认参考，确认满意后再点「确认采用」）",
    };
  }

  // 2. Kling official async video
  if (plan.kind === "video" && snapshot.protocol === "kling-video") {
    const refImg = await loadLockedReferenceImage(projectDir, locked);
    const submitted = await submitKlingVideoTask(
      {
        baseUrl: creds.trustedBaseUrl,
        accessKey: creds.apiKey,
        secretKey: creds.secondaryKey ?? "",
        modelId: snapshot.modelId,
        prompt: locked.finalPrompt,
        negativePrompt: locked.negativePrompt,
        durationSec: locked.durationSec,
        aspectRatio: locked.aspectRatio,
        imageBase64: refImg?.base64 ?? null,
      },
      fetcher,
    );
    const updatedSnap: LockedProviderSnapshot = { ...snapshot, baseUrl: creds.trustedBaseUrl, klingMode: submitted.mode };
    onUpdateJob({ remoteTaskId: submitted.taskId, providerSnapshot: JSON.stringify(updatedSnap), progress: 35 });
    const media = await pollAndDownloadKlingVideo(
      {
        baseUrl: creds.trustedBaseUrl,
        accessKey: creds.apiKey,
        secretKey: creds.secondaryKey ?? "",
        taskId: submitted.taskId,
        mode: submitted.mode,
        projectDir,
        pollIntervalMs,
        maxPollRounds,
        onProgress: (progress) => onUpdateJob({ progress }),
      },
      fetcher,
    );
    return { target: "shot-take", kind: "video", media, message: "视频生成成功并已自动拉回本地保存" };
  }

  // 3. Volcengine Ark Seedance 2.0 / 2.5 official async video
  if (plan.kind === "video" && snapshot.protocol === "seedance-video") {
    const refImg = await loadLockedReferenceImage(projectDir, locked);
    const submitted = await submitSeedanceVideoTask(
      {
        baseUrl: creds.trustedBaseUrl,
        apiKey: creds.apiKey,
        modelId: snapshot.modelId,
        prompt: locked.finalPrompt,
        durationSec: locked.durationSec,
        aspectRatio: locked.aspectRatio,
        imageBase64: refImg?.base64 ?? null,
        imageMime: refImg?.mime ?? "image/jpeg",
      },
      fetcher,
    );
    onUpdateJob({ remoteTaskId: submitted.taskId, progress: 35 });
    const media = await pollAndDownloadSeedanceVideo(
      {
        baseUrl: creds.trustedBaseUrl,
        apiKey: creds.apiKey,
        taskId: submitted.taskId,
        projectDir,
        pollIntervalMs,
        maxPollRounds,
        onProgress: (progress) => onUpdateJob({ progress }),
      },
      fetcher,
    );
    return { target: "shot-take", kind: "video", media, message: "即梦 Seedance 视频生成成功并已自动拉回本地保存" };
  }

  // 4. Google Gemini Official async video (Interactions API)
  if (plan.kind === "video" && snapshot.protocol === "gemini-official") {
    const refImg = await loadLockedReferenceImage(projectDir, locked);
    const submitted = await submitGeminiVideoTask(
      {
        baseUrl: creds.trustedBaseUrl,
        apiKey: creds.apiKey,
        modelId: snapshot.modelId,
        prompt: locked.finalPrompt,
        aspectRatio: locked.aspectRatio,
        imageBase64: refImg?.base64 ?? null,
        imageMime: refImg?.mime ?? "image/jpeg",
      },
      fetcher,
    );
    onUpdateJob({ remoteTaskId: submitted.taskId, progress: 35 });
    const media = await pollAndDownloadGeminiVideo(
      {
        baseUrl: creds.trustedBaseUrl,
        apiKey: creds.apiKey,
        taskId: submitted.taskId,
        projectDir,
        pollIntervalMs,
        maxPollRounds,
        onProgress: (progress) => onUpdateJob({ progress }),
      },
      fetcher,
    );
    return { target: "shot-take", kind: "video", media, message: "Google Gemini 视频生成成功并已自动拉回本地保存" };
  }

  // 5. Google Colab / Local ComfyUI Worker async video
  if (plan.kind === "video" && snapshot.protocol === "comfy-worker") {
    const refImg = await loadLockedReferenceImage(projectDir, locked);
    const submitted = await submitComfyWorkerVideo(
      {
        baseUrl: creds.trustedBaseUrl,
        apiKey: creds.apiKey,
        modelId: snapshot.modelId,
        prompt: locked.finalPrompt,
        negativePrompt: locked.negativePrompt,
        durationSec: locked.durationSec,
        aspectRatio: locked.aspectRatio,
        imageBase64: refImg?.base64 ?? null,
      },
      fetcher,
    );
    onUpdateJob({ remoteTaskId: submitted.taskId, progress: 30 });
    const media = await pollAndDownloadComfyWorkerVideo(
      {
        baseUrl: creds.trustedBaseUrl,
        apiKey: creds.apiKey,
        taskId: submitted.taskId,
        projectDir,
        pollIntervalMs,
        maxPollRounds,
        onProgress: (progress) => onUpdateJob({ progress }),
      },
      fetcher,
    );
    return { target: "shot-take", kind: "video", media, message: "ComfyUI 算力视频生成成功并已自动拉回本地保存" };
  }

  // 6. Grok OAuth async video
  if (plan.kind === "video" && snapshot.protocol === "oauth-grok") {
    const refImg = await loadLockedReferenceImage(projectDir, locked);
    const submitted = await submitGrokVideoTask(
      {
        baseUrl: creds.trustedBaseUrl,
        accessToken: creds.apiKey,
        modelId: snapshot.modelId,
        prompt: locked.finalPrompt,
        durationSec: locked.durationSec,
        aspectRatio: locked.aspectRatio,
        imageBase64: refImg?.base64 ?? null,
      },
      fetcher,
    );
    onUpdateJob({ remoteTaskId: submitted.taskId, progress: 35 });
    const media = await pollAndDownloadGrokVideo(
      {
        baseUrl: creds.trustedBaseUrl,
        accessToken: creds.apiKey,
        taskId: submitted.taskId,
        projectDir,
        pollIntervalMs,
        maxPollRounds,
        onProgress: (progress) => onUpdateJob({ progress }),
      },
      fetcher,
    );
    return { target: "shot-take", kind: "video", media, message: "Grok 视频生成成功并已自动拉回本地保存" };
  }

  // 7. Shot first-frame image generation (Gemini Official, ComfyUI Worker, or OpenAI-compat)
  if (plan.kind === "image") {
    const refImgs = await loadLockedReferenceImages(projectDir, locked);
    const primaryRef = refImgs[0] ?? null;
    const media =
      snapshot.protocol === "gemini-official"
        ? await runGeminiImageGeneration(
            {
              baseUrl: creds.trustedBaseUrl,
              apiKey: creds.apiKey,
              modelId: snapshot.modelId,
              prompt: locked.finalPrompt,
              aspectRatio: locked.aspectRatio,
              projectDir,
              referenceImageBase64: primaryRef?.base64 ?? null,
              referenceImageMime: primaryRef?.mime ?? "image/jpeg",
              referenceImages: refImgs,
            },
            fetcher,
          )
        : snapshot.protocol === "comfy-worker"
          ? await runComfyWorkerImage(
              {
                baseUrl: creds.trustedBaseUrl,
                apiKey: creds.apiKey,
                modelId: snapshot.modelId,
                prompt: locked.finalPrompt,
                negativePrompt: locked.negativePrompt,
                aspectRatio: locked.aspectRatio,
                projectDir,
                referenceImageBase64: primaryRef?.base64 ?? null,
              },
              fetcher,
            )
          : await runOpenAiImageGeneration(
              {
                baseUrl: creds.trustedBaseUrl,
                apiKey: creds.apiKey,
                modelId: snapshot.modelId,
                prompt: locked.finalPrompt,
                aspectRatio: locked.aspectRatio,
                projectDir,
                referenceImageBase64: primaryRef?.base64 ?? null,
                referenceImages: refImgs,
              },
              fetcher,
            );
    return {
      target: "shot-take",
      kind: "image",
      media,
      message: "首帧候选图已生成（未覆盖当前定稿，确认满意后再点「采用」）",
    };
  }

  // 8. Speech TTS synthesis (Gemini Official or OpenAI-compat)
  if (plan.kind === "speech") {
    const voice = locked.speechVoice || "alloy";
    const ttsInput = {
      baseUrl: creds.trustedBaseUrl,
      apiKey: creds.apiKey,
      modelId: snapshot.modelId,
      text: locked.finalPrompt,
      voice,
      projectDir,
    };
    const media =
      snapshot.protocol === "gemini-official"
        ? await runGeminiSpeechSynthesis(ttsInput, fetcher)
        : await runOpenAiSpeechSynthesis(ttsInput, fetcher);
    return {
      target: "shot-take",
      kind: "speech",
      media,
      message: "对白配音候选已生成（未覆盖当前定稿，确认后再采用）",
      promptSnapshotOverride: buildSpeechSnapshot(locked.finalPrompt, voice),
    };
  }

  throw new Error(`当前协议（${snapshot.protocol}）暂不支持此生成类型，请在模型中心切换协议。`);
}

export type RecoveredVideoQuery = {
  status: "succeed" | "failed" | "pending";
  downloadUrl: string | null;
  inlineBase64?: string | null;
  downloadAuth: "none" | "bearer" | "gemini";
  errorMessage: string | null;
  rawStatusLabel: string;
};

export function supportsAsyncRecovery(protocol: LockedProviderSnapshot["protocol"]): boolean {
  return (
    protocol === "kling-video" ||
    protocol === "seedance-video" ||
    protocol === "gemini-official" ||
    protocol === "comfy-worker" ||
    protocol === "oauth-grok"
  );
}

export async function queryRecoverableVideoTask(
  snapshot: LockedProviderSnapshot,
  creds: ResolvedCredentials,
  taskId: string,
  fetcher: typeof fetch,
): Promise<RecoveredVideoQuery> {
  if (snapshot.protocol === "kling-video") {
    const res = await queryKlingVideoTask(
      { baseUrl: creds.trustedBaseUrl, accessKey: creds.apiKey, secretKey: creds.secondaryKey ?? "", taskId, mode: snapshot.klingMode ?? "text2video" },
      fetcher,
    );
    return { status: res.status === "succeed" ? "succeed" : res.status === "failed" ? "failed" : "pending", downloadUrl: res.videoUrl, downloadAuth: "none", errorMessage: res.errorMessage, rawStatusLabel: res.status };
  }
  if (snapshot.protocol === "seedance-video") {
    const res = await querySeedanceVideoTask({ baseUrl: creds.trustedBaseUrl, apiKey: creds.apiKey, taskId }, fetcher);
    return { status: res.status === "succeeded" ? "succeed" : res.status === "failed" ? "failed" : "pending", downloadUrl: res.videoUrl, downloadAuth: "none", errorMessage: res.errorMessage, rawStatusLabel: res.status };
  }
  if (snapshot.protocol === "gemini-official") {
    const res = await queryGeminiVideoTask({ baseUrl: creds.trustedBaseUrl, apiKey: creds.apiKey, taskId }, fetcher);
    return { status: res.status === "succeeded" ? "succeed" : res.status === "failed" ? "failed" : "pending", downloadUrl: res.videoUri, inlineBase64: res.videoBase64, downloadAuth: "gemini", errorMessage: res.errorMessage, rawStatusLabel: res.rawStatus };
  }
  if (snapshot.protocol === "comfy-worker") {
    const res = await queryComfyWorkerVideo({ baseUrl: creds.trustedBaseUrl, apiKey: creds.apiKey, taskId }, fetcher);
    return { status: res.status === "succeeded" ? "succeed" : res.status === "failed" ? "failed" : "pending", downloadUrl: res.downloadUrl, downloadAuth: "bearer", errorMessage: res.errorMessage, rawStatusLabel: res.status };
  }
  const res = await queryGrokVideoTask({ baseUrl: creds.trustedBaseUrl, accessToken: creds.apiKey, taskId }, fetcher);
  return { status: res.status === "succeed" ? "succeed" : res.status === "failed" ? "failed" : "pending", downloadUrl: res.videoUrl, downloadAuth: "none", errorMessage: res.errorMessage, rawStatusLabel: res.status };
}

export async function downloadRecoveredVideo(
  query: RecoveredVideoQuery,
  creds: ResolvedCredentials,
  projectDir: string,
  fetcher: typeof fetch,
): Promise<{ mediaPath: string; mediaSha256: string }> {
  if (query.downloadAuth === "gemini") {
    return downloadVerifiedGeminiVideo(
      {
        baseUrl: creds.trustedBaseUrl,
        apiKey: creds.apiKey,
        videoUri: query.downloadUrl,
        videoBase64: query.inlineBase64 ?? null,
        projectDir,
      },
      fetcher,
    );
  }
  if (!query.downloadUrl) throw new Error("远端未提供可下载的视频地址");
  if (query.downloadAuth === "bearer") {
    return downloadVerifiedComfyVideo({ downloadUrl: query.downloadUrl, apiKey: creds.apiKey, projectDir }, fetcher);
  }
  return downloadVerifiedKlingMp4({ videoUrl: query.downloadUrl, projectDir }, fetcher);
}
