import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AspectRatio } from "../../shared/types/domain";
import {
  DEFAULT_COLAB_MANAGED_CONFIG,
  type ColabManagedConfig,
  type ColabRuntimeStatusView,
} from "../../shared/types/colab";
import type { OAuthManager } from "../auth/auth-manager";
import { probeFfmpegStatus, runMediaBinary } from "../media/ffmpeg-locator";
import type { GlobalConfigStore } from "../storage/global-store";
import {
  ColabApiClient,
  ColabContentsClient,
  type ColabAssignment,
} from "./colab-client";
import {
  executePythonOnColabKernel,
  startOrReuseColabKernel,
  type WebSocketFactory,
} from "./colab-jupyter";
import { AmbiguousRemoteError } from "./kling-adapter";

function buildBootstrapScript(mountDriveCache: boolean): string {
  return [
    "import os, subprocess, sys",
    "os.makedirs('/content/aivora_in', exist_ok=True)",
    "os.makedirs('/content/aivora_out', exist_ok=True)",
    mountDriveCache
      ? [
          "cache_dir = '/content/aivora_models'",
          "if os.path.isdir('/content/drive/MyDrive'):",
          "    cache_dir = '/content/drive/MyDrive/AIVORA_Models'",
          "os.makedirs(cache_dir, exist_ok=True)",
          "os.environ['HF_HOME'] = cache_dir",
          "print('AIVORA_DRIVE_CACHE=' + cache_dir)",
        ].join("\n")
      : "os.environ['HF_HOME'] = '/content/aivora_models'\nos.makedirs('/content/aivora_models', exist_ok=True)",
    "try:",
    "    import diffusers, imageio",
    "except ImportError:",
    "    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', 'diffusers', 'transformers', 'accelerate', 'safetensors', 'imageio[ffmpeg]'])",
    "print('AIVORA_BOOTSTRAP_OK')",
  ].join("\n");
}

function buildImageGenScript(input: {
  taskId: string;
  modelId: string;
  prompt: string;
  aspectRatio: AspectRatio;
}): string {
  const [w, h] = input.aspectRatio === "9:16" ? [768, 1344] : [1344, 768];
  const hfRepo = input.modelId.includes("dev")
    ? "black-forest-labs/FLUX.1-dev"
    : "black-forest-labs/FLUX.1-schnell";
  return [
    "import torch",
    "from diffusers import FluxPipeline",
    `if '_aivora_img_pipe' not in globals() or globals().get('_aivora_img_repo') != ${JSON.stringify(hfRepo)}:`,
    `    _aivora_img_pipe = FluxPipeline.from_pretrained(${JSON.stringify(hfRepo)}, torch_dtype=torch.bfloat16)`,
    "    _aivora_img_pipe.enable_model_cpu_offload()",
    `    _aivora_img_repo = ${JSON.stringify(hfRepo)}`,
    `out = _aivora_img_pipe(prompt=${JSON.stringify(input.prompt)}, width=${w}, height=${h}, num_inference_steps=4, guidance_scale=0.0).images[0]`,
    `out.save(${JSON.stringify(`/content/aivora_out/${input.taskId}.png`)})`,
    `print('AIVORA_IMG_DONE:${input.taskId}')`,
  ].join("\n");
}

function buildVideoGenScript(input: {
  taskId: string;
  modelId: string;
  prompt: string;
  negativePrompt: string;
  durationSec: number;
  aspectRatio: AspectRatio;
  remoteFirstFramePath: string | null;
}): string {
  const [w, h] = input.aspectRatio === "9:16" ? [480, 832] : [832, 480];
  const frames = Math.min(81, Math.max(25, Math.round(input.durationSec * 16) + 1));
  const hfRepo = input.modelId.includes("14b")
    ? "Wan-AI/Wan2.2-I2V-14B-Diffusers"
    : "Wan-AI/Wan2.2-TI2V-5B-Diffusers";
  return [
    "import torch",
    "from PIL import Image",
    "from diffusers import WanImageToVideoPipeline, WanPipeline",
    "from diffusers.utils import export_to_video",
    `has_img = ${input.remoteFirstFramePath ? "True" : "False"}`,
    `repo = ${JSON.stringify(hfRepo)}`,
    "pipe_cls = WanImageToVideoPipeline if has_img else WanPipeline",
    "if '_aivora_vid_pipe' not in globals() or globals().get('_aivora_vid_key') != (repo, has_img):",
    "    _aivora_vid_pipe = pipe_cls.from_pretrained(repo, torch_dtype=torch.bfloat16)",
    "    _aivora_vid_pipe.enable_model_cpu_offload()",
    "    _aivora_vid_key = (repo, has_img)",
    `kwargs = dict(prompt=${JSON.stringify(input.prompt)}, negative_prompt=${JSON.stringify(input.negativePrompt)}, height=${h}, width=${w}, num_frames=${frames}, guidance_scale=5.0)`,
    input.remoteFirstFramePath
      ? `kwargs['image'] = Image.open(${JSON.stringify(`/content/${input.remoteFirstFramePath}`)}).convert('RGB').resize((${w}, ${h}))`
      : "",
    "frames_out = _aivora_vid_pipe(**kwargs).frames[0]",
    `export_to_video(frames_out, ${JSON.stringify(`/content/aivora_out/${input.taskId}.mp4`)}, fps=16)`,
    `print('AIVORA_VID_DONE:${input.taskId}')`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Pure TypeScript managed Google Colab GPU runtime controller.
 * Handles OAuth token fetch, GPU assignment, Drive cache bootstrap, Jupyter WebSocket
 * execution, Contents API upload/download, ffprobe verification, and idle auto-shutdown.
 */
export class ColabManagedRuntimeManager {
  private activeAssignment: ColabAssignment | null = null;
  private activeKernelId: string | null = null;
  private bootstrappedEndpoint: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private status: ColabRuntimeStatusView;

  constructor(
    private readonly globalConfig: GlobalConfigStore,
    private readonly oauth: OAuthManager,
    private readonly fetcher: typeof fetch = fetch,
    private readonly wsFactory?: WebSocketFactory,
  ) {
    const cfg = this.getConfig();
    this.status = {
      state: "idle",
      endpoint: null,
      gpu: cfg.gpu,
      activePreset: null,
      driveMounted: false,
      idleShutdownAt: null,
      ccuBalance: null,
      lastMessage: "尚未分配 GPU 运行时（发起生成时将自动按需启动并在闲置后自动停机）",
    };
  }

  getConfig(): ColabManagedConfig {
    return this.globalConfig.getColabManagedConfig();
  }

  updateConfig(patch: Partial<ColabManagedConfig>): {
    config: ColabManagedConfig;
    status: ColabRuntimeStatusView;
  } {
    const next = this.globalConfig.updateColabManagedConfig(patch);
    this.status.gpu = next.gpu;
    if (this.activeAssignment) this.scheduleIdleShutdown();
    return { config: next, status: this.getStatus() };
  }

  getStatus(): ColabRuntimeStatusView {
    return { ...this.status };
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.status.idleShutdownAt = null;
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    const minutes = Math.max(1, this.getConfig().idleShutdownMinutes || DEFAULT_COLAB_MANAGED_CONFIG.idleShutdownMinutes);
    const delayMs = minutes * 60_000;
    this.status.idleShutdownAt = new Date(Date.now() + delayMs).toISOString();
    this.idleTimer = setTimeout(() => {
      void this.stopRuntime("已达到闲置超时阈值，已自动释放 Colab GPU 运行时");
    }, delayMs);
    this.idleTimer.unref?.();
  }

  private async ensureRuntimeReady(presetLabel: string): Promise<{
    assignment: ColabAssignment;
    kernelId: string;
    contents: ColabContentsClient;
  }> {
    this.clearIdleTimer();
    const cfg = this.getConfig();
    const token = await this.oauth.getValidAccessToken("colab-google");
    const api = new ColabApiClient(token, this.fetcher);

    // Best-effort CCU balance read
    try {
      const ccu = await api.getCcuInfo();
      this.status.ccuBalance = ccu.currentBalance;
    } catch {
      // non-fatal
    }

    const needNewAssign =
      !this.activeAssignment ||
      this.activeAssignment.accelerator !== cfg.gpu ||
      Date.now() > this.activeAssignment.runtimeProxyInfo.expiresAtMs - 120_000;

    if (needNewAssign) {
      if (this.activeAssignment && this.activeAssignment.accelerator !== cfg.gpu) {
        await api.unassignRuntime(this.activeAssignment.endpoint).catch(() => undefined);
      }
      this.status = {
        ...this.status,
        state: "provisioning",
        gpu: cfg.gpu,
        activePreset: presetLabel,
        lastMessage: `正在向 Google Colab 申请 ${cfg.gpu} GPU 运行时…`,
      };
      this.activeAssignment = await api.assignRuntime({ gpu: cfg.gpu });
      this.activeKernelId = null;
      this.bootstrappedEndpoint = null;
    }

    const assignment = this.activeAssignment!;
    const { url: proxyUrl, token: proxyToken } = assignment.runtimeProxyInfo;
    const contents = new ColabContentsClient(proxyUrl, proxyToken, this.fetcher);
    const kernelId = await startOrReuseColabKernel(
      { proxyUrl, proxyToken, existingKernelId: this.activeKernelId },
      this.fetcher,
    );
    this.activeKernelId = kernelId;

    if (this.bootstrappedEndpoint !== assignment.endpoint) {
      this.status = {
        ...this.status,
        state: "bootstrapping",
        endpoint: assignment.endpoint,
        activePreset: presetLabel,
        lastMessage: "正在初始化 Colab 运行环境与模型缓存目录…",
      };
      const bootRes = await executePythonOnColabKernel({
        proxyUrl,
        proxyToken,
        kernelId,
        code: buildBootstrapScript(cfg.mountDriveCache),
        timeoutMs: 300_000,
        wsFactory: this.wsFactory,
      });
      if (bootRes.errorName) {
        throw new Error(`Colab 环境初始化失败：${bootRes.errorName}: ${bootRes.errorValue ?? ""}`);
      }
      this.bootstrappedEndpoint = assignment.endpoint;
      this.status.driveMounted = bootRes.stdout.includes("/content/drive/MyDrive");
    }

    this.status = {
      ...this.status,
      state: "ready",
      endpoint: assignment.endpoint,
      gpu: cfg.gpu,
      activePreset: presetLabel,
      lastMessage: `${cfg.gpu} GPU 已就绪（${assignment.endpoint}）`,
    };
    return { assignment, kernelId, contents };
  }

  async generateImage(input: {
    modelId: string;
    prompt: string;
    aspectRatio: AspectRatio;
    projectDir: string;
  }): Promise<{ mediaPath: string; mediaSha256: string }> {
    const taskId = `img_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const { assignment, kernelId, contents } = await this.ensureRuntimeReady(input.modelId);
    const { url: proxyUrl, token: proxyToken } = assignment.runtimeProxyInfo;

    const execRes = await executePythonOnColabKernel({
      proxyUrl,
      proxyToken,
      kernelId,
      code: buildImageGenScript({
        taskId,
        modelId: input.modelId,
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
      }),
      timeoutMs: 360_000,
      wsFactory: this.wsFactory,
    });
    if (execRes.errorName) {
      this.scheduleIdleShutdown();
      throw new Error(`Colab 生图失败：${execRes.errorName}: ${execRes.errorValue ?? ""}`);
    }

    const bytes = await contents.downloadBytes(`aivora_out/${taskId}.png`);
    if (bytes.length < 64) throw new Error("Colab 返回的图片数据为空");
    await contents.deleteFile(`aivora_out/${taskId}.png`);
    this.scheduleIdleShutdown();

    const sha = createHash("sha256").update(bytes).digest("hex");
    const assetsDir = path.join(input.projectDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    const fileName = `${sha.slice(0, 16)}.png`;
    writeFileSync(path.join(assetsDir, fileName), bytes);
    return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
  }

  async generateVideo(input: {
    modelId: string;
    prompt: string;
    negativePrompt: string;
    durationSec: number;
    aspectRatio: AspectRatio;
    imageBase64?: string | null;
    projectDir: string;
    onSubmitted?: (taskId: string) => void;
    onProgress?: (percent: number) => void;
  }): Promise<{ mediaPath: string; mediaSha256: string }> {
    const taskId = `vid_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const { assignment, kernelId, contents } = await this.ensureRuntimeReady(input.modelId);
    const { url: proxyUrl, token: proxyToken } = assignment.runtimeProxyInfo;

    let remoteFrame: string | null = null;
    if (input.imageBase64) {
      remoteFrame = `aivora_in/${taskId}.jpg`;
      await contents.uploadBytes(remoteFrame, Buffer.from(input.imageBase64, "base64"));
    }

    input.onSubmitted?.(taskId);
    input.onProgress?.(35);

    try {
      const execRes = await executePythonOnColabKernel({
        proxyUrl,
        proxyToken,
        kernelId,
        code: buildVideoGenScript({
          taskId,
          modelId: input.modelId,
          prompt: input.prompt,
          negativePrompt: input.negativePrompt,
          durationSec: input.durationSec,
          aspectRatio: input.aspectRatio,
          remoteFirstFramePath: remoteFrame,
        }),
        timeoutMs: 600_000,
        wsFactory: this.wsFactory,
      });
      if (execRes.errorName) {
        this.scheduleIdleShutdown();
        throw new Error(`Colab 视频生成失败：${execRes.errorName}: ${execRes.errorValue ?? ""}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Colab 视频生成失败")) throw err;
      throw new AmbiguousRemoteError(
        `Colab 视频执行期间连接中断（${err instanceof Error ? err.message : String(err)}），任务号 ${taskId} 已保存，请点击「查单找回」尝试拉回结果，切勿重发。`,
        taskId,
      );
    }

    input.onProgress?.(92);
    const media = await this.downloadAndVerifyVideo(contents, taskId, input.projectDir);
    if (remoteFrame) await contents.deleteFile(remoteFrame);
    await contents.deleteFile(`aivora_out/${taskId}.mp4`);
    this.scheduleIdleShutdown();
    return media;
  }

  /**
   * Read-only UNKNOWN recovery: downloads `/content/aivora_out/{taskId}.mp4` from the live
   * Colab runtime via Contents API without re-executing inference.
   */
  async recoverVideoOutput(
    taskId: string,
    projectDir: string,
  ): Promise<{ mediaPath: string; mediaSha256: string }> {
    const token = await this.oauth.getValidAccessToken("colab-google");
    const api = new ColabApiClient(token, this.fetcher);
    if (!this.activeAssignment) {
      const list = await api.listAssignments();
      this.activeAssignment = list[0] ?? null;
    }
    if (!this.activeAssignment) {
      throw new Error("当前没有存活的 Colab GPU 实例，无法找回已释放实例的临时文件。");
    }
    const contents = new ColabContentsClient(
      this.activeAssignment.runtimeProxyInfo.url,
      this.activeAssignment.runtimeProxyInfo.token,
      this.fetcher,
    );
    const media = await this.downloadAndVerifyVideo(contents, taskId, projectDir);
    this.scheduleIdleShutdown();
    return media;
  }

  private async downloadAndVerifyVideo(
    contents: ColabContentsClient,
    taskId: string,
    projectDir: string,
  ): Promise<{ mediaPath: string; mediaSha256: string }> {
    const bytes = await contents.downloadBytes(`aivora_out/${taskId}.mp4`);
    if (bytes.length < 1024) throw new Error("Colab 返回的视频文件为空或损坏");

    const sha = createHash("sha256").update(bytes).digest("hex");
    const assetsDir = path.join(projectDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    const fileName = `${sha.slice(0, 16)}.mp4`;
    const target = path.join(assetsDir, fileName);
    writeFileSync(target, bytes);

    const ff = await probeFfmpegStatus();
    if (ff.available && ff.ffprobePath) {
      try {
        const { stdout } = await runMediaBinary(ff.ffprobePath, [
          "-v", "error", "-show_streams", "-of", "json", target,
        ]);
        const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
        if (!parsed.streams?.some((s) => s.codec_type === "video")) {
          unlinkSync(target);
          throw new Error("Colab 拉回的视频缺少有效视频流");
        }
      } catch (err) {
        try {
          unlinkSync(target);
        } catch {
          // ignore cleanup failure
        }
        throw err instanceof Error ? err : new Error("Colab 视频流校验失败");
      }
    }
    return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
  }

  async stopRuntime(reason = "已手动停机并释放 Colab GPU 算力"): Promise<{
    ok: boolean;
    status: ColabRuntimeStatusView;
    message: string;
  }> {
    this.clearIdleTimer();
    const endpoint = this.activeAssignment?.endpoint ?? null;
    this.activeAssignment = null;
    this.activeKernelId = null;
    this.bootstrappedEndpoint = null;

    if (endpoint) {
      this.status.state = "stopping";
      try {
        const token = await this.oauth.getValidAccessToken("colab-google");
        const api = new ColabApiClient(token, this.fetcher);
        await api.unassignRuntime(endpoint);
      } catch {
        // best-effort release
      }
    }

    this.status = {
      ...this.status,
      state: "idle",
      endpoint: null,
      activePreset: null,
      driveMounted: false,
      idleShutdownAt: null,
      lastMessage: reason,
    };
    return { ok: true, status: this.getStatus(), message: reason };
  }
}
