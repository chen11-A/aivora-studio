import type { AivoraDesktopApi } from "../../shared/ipc-contract";
import type {
  Asset,
  Episode,
  ProjectSummary,
  ProjectWorkspace,
  Shot,
} from "../../shared/types/domain";
import type { ModelCenterSnapshot, ModelRouting, ProviderConfigView } from "../../shared/types/provider";
import {
  buildPreviewActionPolish,
  buildPreviewDirectorProposal,
  buildPreviewGenerationPlan,
  buildPreviewOutline,
  buildPreviewReviewReport,
} from "./browser-preview-story";

function makeDemoSvgDataUrl(title: string, subtitle: string, tag: string, bg1: string, bg2: string, accent: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${bg1}"/><stop offset="100%" stop-color="${bg2}"/></linearGradient></defs>
    <rect width="1280" height="720" fill="url(#g)"/>
    <rect x="44" y="44" width="1192" height="632" rx="12" fill="none" stroke="#fff" stroke-opacity="0.12"/>
    <rect x="76" y="76" width="176" height="34" rx="17" fill="${accent}" fill-opacity="0.22" stroke="${accent}" stroke-opacity="0.7"/>
    <text x="164" y="99" text-anchor="middle" fill="#F3F6FB" font-family="sans-serif" font-size="16" font-weight="600">${tag}</text>
    <text x="76" y="400" fill="#F8FAFC" font-family="sans-serif" font-size="44" font-weight="700">${title}</text>
    <text x="76" y="452" fill="#CBD5E1" font-family="sans-serif" font-size="22">${subtitle}</text>
    <text x="76" y="644" fill="#94A3B8" font-family="sans-serif" font-size="16">AIVORA STUDIO · 16:9</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createBrowserPreviewApi(): AivoraDesktopApi {
  const now = new Date().toISOString();
  const demoId = "prj_demo_wanzhao";
  const imgShop = makeDemoSvgDataUrl("晚照书店 · 橱窗夕阳", "雨后青石板 · 暖黄台灯 · 老街暮色", "16:9 核心场景", "#1F1A17", "#432818", "#F97316");
  const imgLin = makeDemoSvgDataUrl("林晚 · 角色定妆", "浅灰风衣 · 微湿碎发 · 柔和逆光", "参考已锁定", "#1E293B", "#334155", "#60A5FA");
  const imgChen = makeDemoSvgDataUrl("陈伯 · 角色定妆", "旧针织衫 · 圆框老花镜 · 温暖微笑", "参考已锁定", "#27201A", "#3F2E21", "#F59E0B");
  const imgShot1 = makeDemoSvgDataUrl("镜 01 · 雨后书店外景（版本 2）", "雨珠自屋檐滴落 · 暖光穿透玻璃橱窗", "版本 2 · 使用中", "#1B1917", "#451A03", "#F59E0B");
  const imgShot2 = makeDemoSvgDataUrl("镜 02 · 林晚驻足橱窗", "中近景缓推 · 橱窗倒映夕阳余晖", "版本 1 · 使用中", "#0F172A", "#1E3A5F", "#38BDF8");
  const imgShot3 = makeDemoSvgDataUrl("镜 03 · 推门铜铃轻响", "室内暖光与书架纵深 · 陈伯回头微笑", "版本 1 · 使用中", "#231B15", "#4A321F", "#10B981");

  const workspaces = new Map<string, ProjectWorkspace>([
    [
      demoId,
      {
        project: {
          id: demoId,
          name: "晚照书店",
          aspectRatio: "16:9",
          stylePreset: "胶片电影感 · 暖金黄昏",
          coverAssetPath: imgShop,
          subtitleStyle: "white",
          loudnessNormalize: true,
          bgmAssetId: null,
          bgmVolumeDb: -14,
          createdAt: now,
          updatedAt: now,
        },
        dirPath: "我的作品/晚照书店",
        episodes: [
          {
            id: "ep_1",
            projectId: demoId,
            orderIndex: 0,
            title: "第 1 集 · 雨后重逢",
            scriptText:
              "第一场：晚照书店外 · 傍晚 · 雨后初晴\n橘红色的夕阳斜斜洒在老街湿润的青石板上，屋檐滴落最后一串雨珠。「晚照书店」的木质招牌微微泛黄，橱窗里透出暖黄的台灯光。\n\n林晚（轻声）：这家店居然还开着。\n\n第二场：晚照书店内 · 傍晚\n木门推开，门楣上的铜铃发出清脆一声响。陈伯站在木书架梯子上回头微笑。\n\n陈伯：小晚，你终于回来了。那本夹着银杏叶的书，我替你留了整整三年。",
            sourceAnchors: [],
            updatedAt: now,
          },
          {
            id: "ep_2",
            projectId: demoId,
            orderIndex: 1,
            title: "第 2 集 · 阁楼旧票",
            scriptText: "第三场：书店阁楼 · 夜\n窗外街灯渐亮，林晚翻开夹着银杏叶的诗集，纸页间滑出一张老式火车票。",
            sourceAnchors: [],
            updatedAt: now,
          },
        ],
        assets: [
          { id: "ast_lin", projectId: demoId, kind: "character", name: "林晚", description: "24岁插画师，浅灰风衣，眼神沉静温柔", mediaPath: imgLin, mediaSha256: null, candidatePaths: [imgLin], lockedRef: true, voiceId: "zh_female_warm", updatedAt: now },
          { id: "ast_chen", projectId: demoId, kind: "character", name: "陈伯", description: "68岁旧书店店主，圆框眼镜，语调舒缓", mediaPath: imgChen, mediaSha256: null, candidatePaths: [imgChen], lockedRef: true, voiceId: "zh_male_elder", updatedAt: now },
          { id: "ast_shop", projectId: demoId, kind: "scene", name: "晚照书店", description: "老街木结构书店，黄昏暖光与雨后青石板", mediaPath: imgShop, mediaSha256: null, candidatePaths: [imgShop], lockedRef: true, voiceId: null, updatedAt: now },
        ],
        scenes: [
          { id: "sc_1", episodeId: "ep_1", orderIndex: 0, title: "第一场 · 晚照书店外", locationAssetId: "ast_shop", summary: "雨后傍晚，林晚重返老街书店门口", paragraphStart: 0, paragraphEnd: 2 },
          { id: "sc_2", episodeId: "ep_1", orderIndex: 1, title: "第二场 · 书店内铜铃重逢", locationAssetId: "ast_shop", summary: "推门铜铃响，陈伯递出旧诗集", paragraphStart: 3, paragraphEnd: 5 },
        ],
        shots: [
          { id: "sh_1", sceneId: "sc_1", episodeId: "ep_1", orderIndex: 0, title: "镜 01 · 雨后书店外景", scale: "远景", cameraMove: "缓推", durationSec: 4, trimInSec: 0, trimOutSec: 0, visualPrompt: "雨后傍晚老街，橘红夕阳洒在湿润青石板上，晚照书店暖黄橱窗，电影感 35mm", negativePrompt: "", dialogue: "", speaker: "", speakerAssetId: null, speakerStatus: "none", subtitle: "雨后初晴的老街，晚照书店亮起了灯。", sourceSpan: { paragraphStart: 1, paragraphEnd: 1 }, keyBeat: false, keyBeatReason: "", videoPlanMode: "still_motion", characterAssetIds: [], selectedImageTakeId: "tk_1_2", selectedVideoTakeId: null, selectedSpeechTakeId: null, updatedAt: now },
          { id: "sh_2", sceneId: "sc_1", episodeId: "ep_1", orderIndex: 1, title: "镜 02 · 林晚驻足橱窗", scale: "近景", cameraMove: "缓推", durationSec: 3, trimInSec: 0, trimOutSec: 0, visualPrompt: "林晚停下旧自行车摘下湿帽，侧脸望向橱窗诗集，玻璃倒映夕阳余晖", negativePrompt: "", dialogue: "这家店居然还开着。", speaker: "林晚", speakerAssetId: "ast_lin", speakerStatus: "confirmed", subtitle: "这家店居然还开着。", sourceSpan: { paragraphStart: 2, paragraphEnd: 2 }, keyBeat: true, keyBeatReason: "关键情绪与诗集道具", videoPlanMode: "paid_video", characterAssetIds: ["ast_lin"], selectedImageTakeId: "tk_2_1", selectedVideoTakeId: null, selectedSpeechTakeId: null, updatedAt: now },
          { id: "sh_3", sceneId: "sc_2", episodeId: "ep_1", orderIndex: 2, title: "镜 03 · 推门铜铃轻响", scale: "中景", cameraMove: "横摇", durationSec: 5, trimInSec: 0, trimOutSec: 0, visualPrompt: "书店木门推开铜铃晃动，高大书架间光束穿过微尘，陈伯站在梯子上微笑回头", negativePrompt: "", dialogue: "小晚，你终于回来了。那本夹着银杏叶的书，我替你留了整整三年。", speaker: "陈伯", speakerAssetId: "ast_chen", speakerStatus: "confirmed", subtitle: "那本夹着银杏叶的书，我替你留了整整三年。", sourceSpan: { paragraphStart: 4, paragraphEnd: 5 }, keyBeat: true, keyBeatReason: "关键铜铃重逢节拍", videoPlanMode: "paid_video", characterAssetIds: ["ast_lin", "ast_chen"], selectedImageTakeId: "tk_3_1", selectedVideoTakeId: null, selectedSpeechTakeId: null, updatedAt: now },
        ],
        takes: [
          { id: "tk_1_1", shotId: "sh_1", kind: "image", versionNumber: 1, mediaPath: imgShop, mediaSha256: null, promptSnapshot: "书店外景 v1", providerInfo: "示例画帧 v1", isSelected: false, durationSec: null, createdAt: now },
          { id: "tk_1_2", shotId: "sh_1", kind: "image", versionNumber: 2, mediaPath: imgShot1, mediaSha256: null, promptSnapshot: "雨后傍晚老街，橘红夕阳洒在湿润青石板上，晚照书店暖黄橱窗，电影感 35mm", providerInfo: "示例画帧 v2", isSelected: true, durationSec: null, createdAt: now },
          { id: "tk_2_1", shotId: "sh_2", kind: "image", versionNumber: 1, mediaPath: imgShot2, mediaSha256: null, promptSnapshot: "林晚停下旧自行车摘下湿帽，侧脸望向橱窗诗集，玻璃倒映夕阳余晖 [角色:林晚]", providerInfo: "示例画帧 v1", isSelected: true, durationSec: null, createdAt: now },
          { id: "tk_3_1", shotId: "sh_3", kind: "image", versionNumber: 1, mediaPath: imgShot3, mediaSha256: null, promptSnapshot: "书店木门推开铜铃晃动，高大书架间光束穿过微尘，陈伯站在梯子上微笑回头 [角色:林晚,陈伯]", providerInfo: "示例画帧 v1", isSelected: true, durationSec: null, createdAt: now },
        ],
        jobs: [],
      },
    ],
  ]);

  const modelCenter: ModelCenterSnapshot = {
    vaultAvailable: true,
    oauthAccounts: [
      { providerId: "chatgpt-web", displayName: "ChatGPT 官方账号", status: "disconnected", accountLabel: null, models: [], note: "系统浏览器 PKCE 授权，凭据经系统加密库加密", updatedAt: null },
      { providerId: "grok-web", displayName: "Grok (xAI) 账号", status: "disconnected", accountLabel: null, models: [], note: "支持 OAuth 与 Device Code 登录", updatedAt: null },
    ],
    providers: [],
    routing: { script: null, image: null, video: null, tts: null },
  };

  const toSummary = (ws: ProjectWorkspace): ProjectSummary => ({
    id: ws.project.id,
    name: ws.project.name,
    dirPath: ws.dirPath,
    aspectRatio: ws.project.aspectRatio,
    stylePreset: ws.project.stylePreset,
    coverAssetPath: ws.project.coverAssetPath,
    episodeCount: ws.episodes.length,
    shotCount: ws.shots.length,
    createdAt: ws.project.createdAt,
    updatedAt: ws.project.updatedAt,
  });

  return {
    listProjects: async () => [...workspaces.values()].map(toSummary),
    createProject: async (input) => {
      const id = `prj_${Date.now().toString(36)}`;
      const cover = makeDemoSvgDataUrl(input.name, "新建短剧工程", `${input.aspectRatio} 新建作品`, "#111827", "#1E293B", "#3B82F6");
      const ws: ProjectWorkspace = {
        project: { id, name: input.name, aspectRatio: input.aspectRatio, stylePreset: input.stylePreset || "胶片电影感", coverAssetPath: cover, subtitleStyle: "white", loudnessNormalize: true, bgmAssetId: null, bgmVolumeDb: -14, createdAt: now, updatedAt: now },
        dirPath: `我的作品/${input.name}`,
        episodes: [{ id: `ep_${id}`, projectId: id, orderIndex: 0, title: "第 1 集", scriptText: input.initialScript ?? "", sourceAnchors: [], updatedAt: now }],
        assets: [],
        scenes: [{ id: `sc_${id}`, episodeId: `ep_${id}`, orderIndex: 0, title: "第一场 · 开场镜头", locationAssetId: null, summary: "", paragraphStart: 0, paragraphEnd: 0 }],
        shots: [{ id: `sh_${id}`, sceneId: `sc_${id}`, episodeId: `ep_${id}`, orderIndex: 0, title: "镜 01 · 开场定场", scale: "全景", cameraMove: "缓推", durationSec: 4, trimInSec: 0, trimOutSec: 0, visualPrompt: `${input.name} 开场画面`, negativePrompt: "", dialogue: "", speaker: "", speakerAssetId: null, speakerStatus: "none", subtitle: "", sourceSpan: null, keyBeat: false, keyBeatReason: "", videoPlanMode: "paid_video", characterAssetIds: [], selectedImageTakeId: `tk_${id}`, selectedVideoTakeId: null, selectedSpeechTakeId: null, updatedAt: now }],
        takes: [{ id: `tk_${id}`, shotId: `sh_${id}`, kind: "image", versionNumber: 1, mediaPath: cover, mediaSha256: null, promptSnapshot: "", providerInfo: "初始画板", isSelected: true, durationSec: null, createdAt: now }],
        jobs: [],
      };
      workspaces.set(id, ws);
      return structuredClone(ws);
    },
    openDemoProject: async () => structuredClone(workspaces.get(demoId)!),
    openProject: async (id) => structuredClone(workspaces.get(id)!),
    deleteProject: async (id) => {
      workspaces.delete(id);
      return { ok: true };
    },
    updateProjectSettings: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      Object.assign(ws.project, input, { updatedAt: new Date().toISOString() });
      return structuredClone(ws);
    },
    createEpisode: async (projectId, title) => {
      const ws = workspaces.get(projectId)!;
      const ep: Episode = { id: `ep_${Date.now()}`, projectId, orderIndex: ws.episodes.length, title: title || `第 ${ws.episodes.length + 1} 集`, scriptText: "", sourceAnchors: [], updatedAt: new Date().toISOString() };
      ws.episodes.push(ep);
      return structuredClone(ep);
    },
    updateEpisode: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      const ep = ws.episodes.find((e) => e.id === input.episodeId)!;
      if (input.title !== undefined) ep.title = input.title;
      if (input.scriptText !== undefined) ep.scriptText = input.scriptText;
      ep.updatedAt = new Date().toISOString();
      return structuredClone(ep);
    },
    createAsset: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      const asset: Asset = { id: `ast_${Date.now()}`, projectId: input.projectId, kind: input.kind, name: input.name, description: input.description ?? "", mediaPath: imgLin, mediaSha256: null, candidatePaths: [imgLin], lockedRef: false, voiceId: input.voiceId ?? null, updatedAt: new Date().toISOString() };
      ws.assets.unshift(asset);
      return structuredClone(asset);
    },
    updateAsset: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      const asset = ws.assets.find((a) => a.id === input.assetId)!;
      Object.assign(asset, input, { updatedAt: new Date().toISOString() });
      return structuredClone(asset);
    },
    toggleAssetLock: async (projectId, assetId) => {
      const ws = workspaces.get(projectId)!;
      const asset = ws.assets.find((a) => a.id === assetId)!;
      asset.lockedRef = !asset.lockedRef;
      return structuredClone(asset);
    },
    importAssetImage: async () => ({ ok: false, message: "请在桌面端导入本地定妆参考图" }),
    selectAssetCandidate: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      const asset = ws.assets.find((a) => a.id === input.assetId)!;
      asset.mediaPath = input.mediaPath;
      asset.lockedRef = true;
      return structuredClone(asset);
    },
    createShot: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      const epShots = ws.shots.filter((s) => s.episodeId === input.episodeId).sort((a, b) => a.orderIndex - b.orderIndex);
      const targetIdx = input.beforeShotId ? epShots.findIndex((s) => s.id === input.beforeShotId) : -1;
      const insertIdx = targetIdx >= 0 ? targetIdx : epShots.length;
      for (const s of epShots) if (s.orderIndex >= insertIdx) s.orderIndex += 1;
      const shot: Shot = { id: `sh_${Date.now()}`, sceneId: input.sceneId, episodeId: input.episodeId, orderIndex: insertIdx, title: `镜 ${String(insertIdx + 1).padStart(2, "0")} · 新镜头`, scale: "中景", cameraMove: "固定", durationSec: 3, trimInSec: 0, trimOutSec: 0, visualPrompt: "", negativePrompt: "", dialogue: "", speaker: "", speakerAssetId: null, speakerStatus: "none", subtitle: "", sourceSpan: null, keyBeat: false, keyBeatReason: "", videoPlanMode: "paid_video", characterAssetIds: [], selectedImageTakeId: null, selectedVideoTakeId: null, selectedSpeechTakeId: null, updatedAt: new Date().toISOString() };
      ws.shots.push(shot);
      return structuredClone(shot);
    },
    moveShot: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      const target = ws.shots.find((s) => s.id === input.shotId)!;
      const epShots = ws.shots.filter((s) => s.episodeId === target.episodeId).sort((a, b) => a.orderIndex - b.orderIndex);
      const idx = epShots.findIndex((s) => s.id === input.shotId);
      const swapIdx = input.direction === "up" ? idx - 1 : idx + 1;
      if (idx >= 0 && swapIdx >= 0 && swapIdx < epShots.length) {
        const tmp = epShots[idx]!;
        epShots[idx] = epShots[swapIdx]!;
        epShots[swapIdx] = tmp;
        epShots.forEach((s, i) => {
          s.orderIndex = i;
        });
      }
      return structuredClone(ws);
    },
    deleteShot: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      const target = ws.shots.find((s) => s.id === input.shotId)!;
      ws.shots = ws.shots.filter((s) => s.id !== input.shotId);
      ws.shots
        .filter((s) => s.episodeId === target.episodeId)
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .forEach((s, i) => {
          s.orderIndex = i;
        });
      return structuredClone(ws);
    },
    updateShot: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      const shot = ws.shots.find((s) => s.id === input.shotId)!;
      Object.assign(shot, input, { updatedAt: new Date().toISOString() });
      return structuredClone(shot);
    },
    selectTake: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      for (const t of ws.takes) {
        if (t.shotId !== input.shotId) continue;
        if (input.kind === "speech" && t.kind === "speech") t.isSelected = t.id === input.takeId;
        if (input.kind !== "speech" && (t.kind === "image" || t.kind === "video")) {
          t.isSelected = t.id === input.takeId;
        }
      }
      const shot = ws.shots.find((s) => s.id === input.shotId)!;
      if (input.kind === "image") {
        shot.selectedImageTakeId = input.takeId;
        shot.selectedVideoTakeId = null;
      }
      if (input.kind === "video") shot.selectedVideoTakeId = input.takeId;
      if (input.kind === "speech") shot.selectedSpeechTakeId = input.takeId;
      return structuredClone(ws);
    },
    addSyntheticTake: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      const ver = ws.takes.filter((t) => t.shotId === input.shotId && (t.kind === "image" || t.kind === "video")).length + 1;
      const id = `tk_${Date.now()}`;
      for (const t of ws.takes) if (t.shotId === input.shotId && (t.kind === "image" || t.kind === "video")) t.isSelected = false;
      ws.takes.push({ id, shotId: input.shotId, kind: input.kind, versionNumber: ver, mediaPath: makeDemoSvgDataUrl(`版本 ${ver}`, "新候选画面", `版本 ${ver}`, "#111C1B", "#134E4A", "#10B981"), mediaSha256: null, promptSnapshot: "", providerInfo: "本地候选", isSelected: true, durationSec: null, createdAt: new Date().toISOString() });
      const shot = ws.shots.find((s) => s.id === input.shotId)!;
      if (input.kind === "image") {
        shot.selectedImageTakeId = id;
        shot.selectedVideoTakeId = null;
      }
      if (input.kind === "video") shot.selectedVideoTakeId = id;
      return structuredClone(ws);
    },
    importShotTake: async () => ({ ok: false, message: "请在桌面端导入本地视频/图片/音频素材" }),
    exportExternalShotPack: async () => ({ ok: false, message: "请在桌面端导出网页外采包" }),
    scanExternalDropFolder: async () => ({ ok: false, items: [], matchedCount: 0, unmatchedCount: 0, duplicateCount: 0, ignoredTempCount: 0, message: "请在桌面端扫描回流目录" }),
    commitExternalDropImport: async () => ({ ok: false, importedCount: 0, skippedCount: 0, message: "请在桌面端批量导入回流文件" }),
    getDownloadWatchState: async () => ({ enabled: false, folderDir: "Downloads", defaultDir: "Downloads" }),
    configureDownloadWatch: async (input) => ({ enabled: input.enabled, folderDir: input.folderDir ?? "Downloads", defaultDir: "Downloads" }),
    onExternalDownloadDetected: () => () => undefined,
    importProjectBgm: async () => ({ ok: false, message: "请在桌面端导入本地背景音乐" }),
    listBuiltinBgm: async () => [],
    applyBuiltinBgm: async ({ projectId }) => ({ ok: false, projectId, message: "请在桌面端试听并采用内置无版权配乐" }),
    generateProjectBgm: async ({ projectId }) => ({ ok: false, projectId, message: "请在桌面端配置 Gemini API Key 后生成 Lyria 候选配乐" }),
    applyProjectBgmCandidate: async ({ projectId }) => ({ ok: false, projectId, message: "请在桌面端采用候选配乐" }),
    deleteProjectBgmCandidate: async ({ projectId }) => ({ ok: false, projectId, message: "请在桌面端移除候选配乐" }),
    clearProjectBgm: async (projectId) => {
      const ws = workspaces.get(projectId)!;
      ws.project.bgmAssetId = null;
      return structuredClone(ws);
    },
    checkFfmpegStatus: async () => ({
      available: true,
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      version: "browser-preview",
      message: "FFmpeg 导出引擎已就绪（桌面端执行真实编码）",
    }),
    exportEpisodeVideo: async () => ({
      ok: false,
      message: "浏览器预览模式不调用本地 FFmpeg，请在桌面端导出真实 MP4。",
    }),
    onExportProgress: () => () => undefined,
    revealPathInFolder: async () => ({ ok: false }),
    openExternalUrl: async (url) => {
      if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
      return { ok: true };
    },
    exportProjectArchive: async () => ({ ok: true, message: "浏览器预览模式不写入磁盘" }),
    importProjectArchive: async () => ({ ok: false, message: "请在桌面端使用工程包导入" }),
    cleanUnreferencedAssets: async () => ({ ok: true, removedFiles: 0, freedBytes: 0, message: "当前作品目录干净，没有未引用的孤儿缓存文件" }),
    getModelCenter: async () => structuredClone(modelCenter),
    saveProviderConfig: async (input) => {
      const prev = input.id ? modelCenter.providers.find((p) => p.id === input.id) : undefined;
      const saved: ProviderConfigView = {
        id: input.id || `prv_${Date.now()}`,
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        models: input.models,
        hasSecret: Boolean(input.apiKey) || Boolean(prev?.hasSecret),
        keyHint: input.apiKey ? `••••${input.apiKey.slice(-4)}` : (prev?.keyHint ?? null),
        enabled: input.enabled,
        lastTestOk: prev?.lastTestOk ?? null,
        lastTestMessage: prev?.lastTestMessage ?? null,
        updatedAt: new Date().toISOString(),
      };
      modelCenter.providers = [saved, ...modelCenter.providers.filter((p) => p.id !== saved.id)];
      return structuredClone(saved);
    },
    deleteProviderConfig: async (id) => {
      modelCenter.providers = modelCenter.providers.filter((p) => p.id !== id);
      return { ok: true };
    },
    updateModelRouting: async (routing: ModelRouting) => {
      modelCenter.routing = structuredClone(routing);
      return structuredClone(routing);
    },
    testProviderConnection: async (providerId) => ({
      ok: true,
      providerId,
      latencyMs: 42,
      message: "浏览器预览模式：接口连通模拟通过（42ms）",
    }),
    fetchProviderModels: async (providerId) => {
      const p = modelCenter.providers.find((x) => x.id === providerId);
      return { ok: true, models: p?.models ?? ["gpt-4.1"], message: "浏览器预览模式：已返回当前模型列表" };
    },
    updateOAuthModels: async ({ providerId, models }) => {
      const acc = modelCenter.oauthAccounts.find((a) => a.providerId === providerId);
      if (acc) acc.models = [...models];
      return structuredClone(modelCenter);
    },
    oauthStartLogin: async (providerId) => ({
      ok: false,
      providerId,
      status: "disconnected",
      message: "请在桌面端打开系统浏览器完成网页 OAuth 授权",
    }),
    oauthDisconnect: async () => ({ ok: true, message: "已断开授权" }),
    proposeScreenwriterOutline: async ({ rawText, defaultTitle }) => ({
      ok: true,
      outline: buildPreviewOutline(rawText, defaultTitle),
      message: "已生成编剧预分集/分场草案",
    }),
    applyScreenwriterOutline: async ({ projectId }) => ({
      ok: true,
      workspace: structuredClone(workspaces.get(projectId)!),
      createdEpisodeIds: [workspaces.get(projectId)!.episodes[0]!.id],
      message: "已按预分场结构更新分集与场次",
    }),
    proposeDirectorSplit: async ({ projectId, episodeId, softTargetShotsPerScene }) => ({
      ok: true,
      message: "已生成三步提案预览（编剧分场 → 导演分镜 → 原文审片）",
      proposal: buildPreviewDirectorProposal(workspaces.get(projectId), episodeId, softTargetShotsPerScene),
    }),
    applyDirectorProposal: async ({ projectId }) => ({
      ok: true,
      workspace: structuredClone(workspaces.get(projectId)!),
      undoToken: "preview_undo",
      message: "已采纳导演拆镜提案（随时可一键撤销）",
    }),
    undoDirectorApply: async ({ projectId }) => ({
      ok: true,
      workspace: structuredClone(workspaces.get(projectId)!),
      message: "已撤销拆镜提案",
    }),
    getDirectorUndoState: async () => ({ undoToken: null }),
    reviewEpisodeShots: async ({ projectId, episodeId }) => {
      const ws = workspaces.get(projectId)!;
      const ep = ws.episodes.find((e) => e.id === episodeId);
      const paras = (ep?.scriptText || "").split(/\n+/).filter(Boolean).length;
      const shotsCount = ws.shots.filter((s) => s.episodeId === episodeId).length;
      const report = buildPreviewReviewReport(ep?.title || "第 1 集", paras, shotsCount);
      return { ok: true, report, message: report.summary };
    },
    proposeActionPolish: async ({ projectId, shotId }) => {
      const ws = workspaces.get(projectId)!;
      return {
        ok: true,
        proposal: buildPreviewActionPolish(ws, shotId),
        message: "已生成单镜动作三拍精修建议（确认后采纳）",
      };
    },
    prepareGenerationPlan: async (input) =>
      buildPreviewGenerationPlan(workspaces.get(input.projectId)!, input),
    confirmAndRunJob: async () => {
      throw new Error("请在桌面端配置模型后发起真实生成");
    },
    recoverUnknownJob: async () => {
      throw new Error("请在桌面端使用查单找回");
    },
    listProjectJobs: async () => [],
    prepareBatchPlan: async ({ projectId, episodeId, mode }) => {
      const ws = workspaces.get(projectId)!;
      const epShots = ws.shots.filter((s) => s.episodeId === episodeId);
      const paidVideoShotsInEpisode = epShots.filter((s) => s.videoPlanMode === "paid_video").length;
      return {
        batchId: `bat_${Date.now()}`,
        projectId,
        episodeId,
        mode,
        totalShotsInEpisode: epShots.length,
        paidVideoShotsInEpisode,
        stillMotionSkippedCount: epShots.length - paidVideoShotsInEpisode,
        blockedUnconfirmedSpeakerShots: [],
        skippedReadyCount: 0,
        plans: [],
        providerLabel: "未配置模型",
        modelId: "",
        estimatedTotalSec: 0,
        canRun: false,
        blockingReason: "请先在「模型中心」配置对应环节的模型路由与密钥，再启动批量补齐。",
      };
    },
    startBatchRun: async () => {
      throw new Error("请在桌面端发起批量生成");
    },
    pauseBatchRun: async () => ({ ok: false, message: "当前没有运行中的批量任务" }),
    getBatchProgress: async () => null,
    preflightExportEpisode: async () => ({
      ok: true,
      blockingIssues: [],
      warnings: [],
      shortClips: [],
      freeSpaceMb: 4096,
    }),
    cancelEpisodeExport: async () => ({ ok: false, message: "浏览器预览模式无导出任务" }),
    onFlushBeforeClose: () => () => undefined,
    notifyFlushComplete: () => undefined,
    getAppInfo: async () => ({ version: "2.1.0", workspaceRoot: "我的作品", sqliteEngine: "browser-preview", platform: "web" }),
    loadDeliveryQueue: async () => null,
    runMultiEpisodeDelivery: async () => ({
      ok: false, queue: null, rerenderedCount: 0, skippedVerifiedCount: 0, failedEpisodeIds: [], mergedOutputPath: null,
      message: "请在桌面端执行多集交付与断点续跑",
    }),
    runEpisodeContentQc: async ({ episodeId }) => ({
      episodeId, snapshotDigest: "preview", ok: true, requiresHumanSignOff: true, humanSignedOff: false,
      errorCount: 0, warnCount: 0, issues: [], highRiskSeamShotIds: [], summary: "浏览器预览模式",
    }),
    signOffEpisodeReview: async () => ({ ok: false, snapshotDigest: "preview", message: "请在桌面端确认审片" }),
    getBudgetOverview: async (projectId) => ({
      summary: { projectId, maxBudgetCents: 0, settledCents: 0, estimatedSettledCents: 0, reservedCents: 0, unknownHoldCents: 0, unknownHoldCount: 0, remainingCents: null },
      recoveryItems: [],
    }),
    setProjectBudgetCap: async ({ projectId, maxBudgetCents }) => ({
      projectId, maxBudgetCents, settledCents: 0, estimatedSettledCents: 0, reservedCents: 0, unknownHoldCents: 0, unknownHoldCount: 0, remainingCents: maxBudgetCents > 0 ? maxBudgetCents : null,
    }),
    resumePlannedLedger: async () => ({ ok: false, action: "blocked_unknown", message: "请在桌面端执行中断任务续跑" }),
    extractPrevShotTailFrame: async () => ({ ok: false, message: "请在桌面端抽取上一镜真实尾帧" }),
    importShotEndFrame: async () => ({ ok: false, message: "请在桌面端导入尾帧图片" }),
    importShotReferenceVideo: async () => ({ ok: false, message: "请在桌面端导入运镜/特效参考视频" }),
    updateEpisodeBgmCues: async ({ projectId, episodeId, bgmCues }) => {
      const ws = workspaces.get(projectId);
      if (ws) ws.episodes = ws.episodes.map((e) => (e.id === episodeId ? { ...e, bgmCues } : e));
      return { ok: Boolean(ws), workspace: ws ? structuredClone(ws) : undefined, message: "已更新预览分段配乐" };
    },
    autoPlanEpisodeBgm: async () => ({ ok: false, cues: [], message: "请在桌面端使用按场次自动配乐" }),
    mediaUrl: (_projectId, relativePath) => relativePath,
    resolveDroppedFilePath: () => null,
  };
}

let cachedClient: AivoraDesktopApi | null = null;

export function getDesktopClient(): AivoraDesktopApi {
  if (typeof window !== "undefined" && window.aivora) return window.aivora;
  if (!cachedClient) cachedClient = createBrowserPreviewApi();
  return cachedClient;
}
