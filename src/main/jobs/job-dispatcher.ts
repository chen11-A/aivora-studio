import {
  buildSpeechSnapshot,
  resolveConfirmedFirstFrameTake,
  resolveShotSpeechVoiceId,
} from "../../shared/media-selection";
import type { ProjectWorkspace, Shot } from "../../shared/types/domain";
import type { GenerationPlan } from "../../shared/types/jobs";
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
import {
  injectLockedReferences,
  prepareReferenceImageForUpload,
} from "../providers/ref-image-injector";
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

export async function dispatchGenerationJob(ctx: {
  plan: GenerationPlan;
  ws: ProjectWorkspace;
  shot: Shot | null;
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
  const { plan, ws, shot, snapshot, creds, fetcher, pollIntervalMs, maxPollRounds, onUpdateJob } = ctx;

  // 1. Asset portrait candidate generation
  if (plan.assetId && plan.kind === "image") {
    const baseInput = {
      baseUrl: creds.trustedBaseUrl,
      apiKey: creds.apiKey,
      modelId: snapshot.modelId,
      prompt: plan.promptPreview,
      aspectRatio: ws.project.aspectRatio,
      projectDir: ws.dirPath,
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

  if (!shot) throw new Error("镜头不存在");

  // 2. Kling official async video
  if (plan.kind === "video" && snapshot.protocol === "kling-video") {
    const firstFrame = resolveConfirmedFirstFrameTake(shot, ws.takes);
    const prepared = injectLockedReferences(ws, ws.dirPath, shot, firstFrame?.mediaPath ?? null);
    const refImg = await prepareReferenceImageForUpload(prepared.primaryReferenceImagePath);
    const submitted = await submitKlingVideoTask(
      {
        baseUrl: creds.trustedBaseUrl,
        accessKey: creds.apiKey,
        secretKey: creds.secondaryKey ?? "",
        modelId: snapshot.modelId,
        prompt: prepared.finalPrompt,
        negativePrompt: shot.negativePrompt,
        durationSec: shot.durationSec,
        aspectRatio: ws.project.aspectRatio,
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
        projectDir: ws.dirPath,
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
    const firstFrame = resolveConfirmedFirstFrameTake(shot, ws.takes);
    const prepared = injectLockedReferences(ws, ws.dirPath, shot, firstFrame?.mediaPath ?? null);
    const refImg = await prepareReferenceImageForUpload(prepared.primaryReferenceImagePath);
    const submitted = await submitSeedanceVideoTask(
      {
        baseUrl: creds.trustedBaseUrl,
        apiKey: creds.apiKey,
        modelId: snapshot.modelId,
        prompt: prepared.finalPrompt,
        durationSec: shot.durationSec,
        aspectRatio: ws.project.aspectRatio,
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
        projectDir: ws.dirPath,
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
    const firstFrame = resolveConfirmedFirstFrameTake(shot, ws.takes);
    const prepared = injectLockedReferences(ws, ws.dirPath, shot, firstFrame?.mediaPath ?? null);
    const refImg = await prepareReferenceImageForUpload(prepared.primaryReferenceImagePath);
    const submitted = await submitGeminiVideoTask(
      {
        baseUrl: creds.trustedBaseUrl,
        apiKey: creds.apiKey,
        modelId: snapshot.modelId,
        prompt: prepared.finalPrompt,
        aspectRatio: ws.project.aspectRatio,
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
        projectDir: ws.dirPath,
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
    const firstFrame = resolveConfirmedFirstFrameTake(shot, ws.takes);
    const prepared = injectLockedReferences(ws, ws.dirPath, shot, firstFrame?.mediaPath ?? null);
    const refImg = await prepareReferenceImageForUpload(prepared.primaryReferenceImagePath);
    const submitted = await submitComfyWorkerVideo(
      {
        baseUrl: creds.trustedBaseUrl,
        apiKey: creds.apiKey,
        modelId: snapshot.modelId,
        prompt: prepared.finalPrompt,
        negativePrompt: shot.negativePrompt,
        durationSec: shot.durationSec,
        aspectRatio: ws.project.aspectRatio,
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
        projectDir: ws.dirPath,
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
    const firstFrame = resolveConfirmedFirstFrameTake(shot, ws.takes);
    const prepared = injectLockedReferences(ws, ws.dirPath, shot, firstFrame?.mediaPath ?? null);
    const refImg = await prepareReferenceImageForUpload(prepared.primaryReferenceImagePath);
    const submitted = await submitGrokVideoTask(
      {
        baseUrl: creds.trustedBaseUrl,
        accessToken: creds.apiKey,
        modelId: snapshot.modelId,
        prompt: prepared.finalPrompt,
        durationSec: shot.durationSec,
        aspectRatio: ws.project.aspectRatio,
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
        projectDir: ws.dirPath,
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
    const prepared = injectLockedReferences(ws, ws.dirPath, shot, null);
    const refImg = await prepareReferenceImageForUpload(prepared.primaryReferenceImagePath);
    const media =
      snapshot.protocol === "gemini-official"
        ? await runGeminiImageGeneration(
            {
              baseUrl: creds.trustedBaseUrl,
              apiKey: creds.apiKey,
              modelId: snapshot.modelId,
              prompt: plan.promptPreview,
              aspectRatio: ws.project.aspectRatio,
              projectDir: ws.dirPath,
              referenceImageBase64: refImg?.base64 ?? null,
              referenceImageMime: refImg?.mime ?? "image/jpeg",
            },
            fetcher,
          )
        : snapshot.protocol === "comfy-worker"
          ? await runComfyWorkerImage(
              {
                baseUrl: creds.trustedBaseUrl,
                apiKey: creds.apiKey,
                modelId: snapshot.modelId,
                prompt: plan.promptPreview,
                negativePrompt: shot.negativePrompt,
                aspectRatio: ws.project.aspectRatio,
                projectDir: ws.dirPath,
                referenceImageBase64: refImg?.base64 ?? null,
              },
              fetcher,
            )
          : await runOpenAiImageGeneration(
              {
                baseUrl: creds.trustedBaseUrl,
                apiKey: creds.apiKey,
                modelId: snapshot.modelId,
                prompt: plan.promptPreview,
                aspectRatio: ws.project.aspectRatio,
                projectDir: ws.dirPath,
                referenceImageBase64: refImg?.base64 ?? null,
              },
              fetcher,
            );
    return { target: "shot-take", kind: "image", media, message: "首帧图生成成功，已新增版本并选中" };
  }

  // 8. Speech TTS synthesis (Gemini Official or OpenAI-compat)
  if (plan.kind === "speech") {
    const voice = resolveShotSpeechVoiceId(shot, ws.assets);
    const ttsInput = {
      baseUrl: creds.trustedBaseUrl,
      apiKey: creds.apiKey,
      modelId: snapshot.modelId,
      text: plan.promptPreview,
      voice,
      projectDir: ws.dirPath,
    };
    const media =
      snapshot.protocol === "gemini-official"
        ? await runGeminiSpeechSynthesis(ttsInput, fetcher)
        : await runOpenAiSpeechSynthesis(ttsInput, fetcher);
    return {
      target: "shot-take",
      kind: "speech",
      media,
      message: "对白配音生成成功，已绑定至当前镜头",
      promptSnapshotOverride: buildSpeechSnapshot(plan.promptPreview, voice),
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
      { apiKey: creds.apiKey, videoUri: query.downloadUrl, videoBase64: query.inlineBase64 ?? null, projectDir },
      fetcher,
    );
  }
  if (!query.downloadUrl) throw new Error("远端未提供可下载的视频地址");
  if (query.downloadAuth === "bearer") {
    return downloadVerifiedComfyVideo({ downloadUrl: query.downloadUrl, apiKey: creds.apiKey, projectDir }, fetcher);
  }
  return downloadVerifiedKlingMp4({ videoUrl: query.downloadUrl, projectDir }, fetcher);
}
