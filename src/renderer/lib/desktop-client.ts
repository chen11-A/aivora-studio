import type { AivoraDesktopApi } from "../../shared/ipc-contract";
import type {
  Asset,
  Episode,
  ProjectSummary,
  ProjectWorkspace,
  Shot,
} from "../../shared/types/domain";
import type { ModelCenterSnapshot, ModelRouting, ProviderConfigView } from "../../shared/types/provider";

function makeDemoSvgDataUrl(title: string, subtitle: string, tag: string, bg1: string, bg2: string, accent: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${bg1}"/><stop offset="100%" stop-color="${bg2}"/></linearGradient></defs>
    <rect width="1280" height="720" fill="url(#g)"/>
    <rect x="44" y="44" width="1192" height="632" rx="12" fill="none" stroke="#fff" stroke-opacity="0.12"/>
    <rect x="76" y="76" width="176" height="34" rx="17" fill="${accent}" fill-opacity="0.22" stroke="${accent}" stroke-opacity="0.7"/>
    <text x="164" y="99" text-anchor="middle" fill="#F3F6FB" font-family="sans-serif" font-size="16" font-weight="600">${tag}</text>
    <text x="76" y="400" fill="#F8FAFC" font-family="sans-serif" font-size="44" font-weight="700">${title}</text>
    <text x="76" y="452" fill="#CBD5E1" font-family="sans-serif" font-size="22">${subtitle}</text>
    <text x="76" y="644" fill="#94A3B8" font-family="monospace" font-size="16">AIVORA STUDIO · 16:9</text>
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
          { id: "ast_lin", projectId: demoId, kind: "character", name: "林晚", description: "24岁插画师，浅灰风衣，眼神沉静温柔", mediaPath: imgLin, mediaSha256: null, lockedRef: true, voiceId: "zh_female_warm", updatedAt: now },
          { id: "ast_chen", projectId: demoId, kind: "character", name: "陈伯", description: "68岁旧书店店主，圆框眼镜，语调舒缓", mediaPath: imgChen, mediaSha256: null, lockedRef: true, voiceId: "zh_male_elder", updatedAt: now },
          { id: "ast_shop", projectId: demoId, kind: "scene", name: "晚照书店", description: "老街木结构书店，黄昏暖光与雨后青石板", mediaPath: imgShop, mediaSha256: null, lockedRef: true, voiceId: null, updatedAt: now },
        ],
        scenes: [
          { id: "sc_1", episodeId: "ep_1", orderIndex: 0, title: "第一场 · 晚照书店外", locationAssetId: "ast_shop", summary: "雨后傍晚，林晚重返老街书店门口", paragraphStart: 0, paragraphEnd: 2 },
          { id: "sc_2", episodeId: "ep_1", orderIndex: 1, title: "第二场 · 书店内铜铃重逢", locationAssetId: "ast_shop", summary: "推门铜铃响，陈伯递出旧诗集", paragraphStart: 3, paragraphEnd: 5 },
        ],
        shots: [
          { id: "sh_1", sceneId: "sc_1", episodeId: "ep_1", orderIndex: 0, title: "镜 01 · 雨后书店外景", scale: "远景", cameraMove: "缓推", durationSec: 4, visualPrompt: "雨后傍晚老街，橘红夕阳洒在湿润青石板上，晚照书店暖黄橱窗，电影感 35mm", negativePrompt: "", dialogue: "", speaker: "", subtitle: "雨后初晴的老街，晚照书店亮起了灯。", characterAssetIds: [], selectedImageTakeId: "tk_1_2", selectedVideoTakeId: null, selectedSpeechTakeId: null, updatedAt: now },
          { id: "sh_2", sceneId: "sc_1", episodeId: "ep_1", orderIndex: 1, title: "镜 02 · 林晚驻足橱窗", scale: "近景", cameraMove: "缓推", durationSec: 3, visualPrompt: "林晚停下旧自行车摘下湿帽，侧脸望向橱窗诗集，玻璃倒映夕阳余晖", negativePrompt: "", dialogue: "这家店居然还开着。", speaker: "林晚", subtitle: "这家店居然还开着。", characterAssetIds: ["ast_lin"], selectedImageTakeId: "tk_2_1", selectedVideoTakeId: null, selectedSpeechTakeId: null, updatedAt: now },
          { id: "sh_3", sceneId: "sc_2", episodeId: "ep_1", orderIndex: 2, title: "镜 03 · 推门铜铃轻响", scale: "中景", cameraMove: "横摇", durationSec: 5, visualPrompt: "书店木门推开铜铃晃动，高大书架间光束穿过微尘，陈伯站在梯子上微笑回头", negativePrompt: "", dialogue: "小晚，你终于回来了。那本夹着银杏叶的书，我替你留了整整三年。", speaker: "陈伯", subtitle: "那本夹着银杏叶的书，我替你留了整整三年。", characterAssetIds: ["ast_lin", "ast_chen"], selectedImageTakeId: "tk_3_1", selectedVideoTakeId: null, selectedSpeechTakeId: null, updatedAt: now },
        ],
        takes: [
          { id: "tk_1_1", shotId: "sh_1", kind: "image", versionNumber: 1, mediaPath: imgShop, mediaSha256: null, promptSnapshot: "书店外景 v1", providerInfo: "示例画帧 v1", isSelected: false, durationSec: null, createdAt: now },
          { id: "tk_1_2", shotId: "sh_1", kind: "image", versionNumber: 2, mediaPath: imgShot1, mediaSha256: null, promptSnapshot: "雨后晚霞书店外景 v2", providerInfo: "示例画帧 v2", isSelected: true, durationSec: null, createdAt: now },
          { id: "tk_2_1", shotId: "sh_2", kind: "image", versionNumber: 1, mediaPath: imgShot2, mediaSha256: null, promptSnapshot: "林晚橱窗近景", providerInfo: "示例画帧 v1", isSelected: true, durationSec: null, createdAt: now },
          { id: "tk_3_1", shotId: "sh_3", kind: "image", versionNumber: 1, mediaPath: imgShot3, mediaSha256: null, promptSnapshot: "推门重逢", providerInfo: "示例画帧 v1", isSelected: true, durationSec: null, createdAt: now },
        ],
        jobs: [],
      },
    ],
  ]);

  const modelCenter: ModelCenterSnapshot = {
    vaultAvailable: true,
    oauthAccounts: [
      { providerId: "chatgpt-web", displayName: "ChatGPT 官方账号", status: "disconnected", accountLabel: null, models: [], note: "系统浏览器 PKCE 授权，凭据经 DPAPI 加密", updatedAt: null },
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
        shots: [{ id: `sh_${id}`, sceneId: `sc_${id}`, episodeId: `ep_${id}`, orderIndex: 0, title: "镜 01 · 开场定场", scale: "全景", cameraMove: "缓推", durationSec: 4, visualPrompt: `${input.name} 开场画面`, negativePrompt: "", dialogue: "", speaker: "", subtitle: "", characterAssetIds: [], selectedImageTakeId: `tk_${id}`, selectedVideoTakeId: null, selectedSpeechTakeId: null, updatedAt: now }],
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
      const asset: Asset = { id: `ast_${Date.now()}`, projectId: input.projectId, kind: input.kind, name: input.name, description: input.description ?? "", mediaPath: imgLin, mediaSha256: null, lockedRef: false, voiceId: input.voiceId ?? null, updatedAt: new Date().toISOString() };
      ws.assets.unshift(asset);
      return structuredClone(asset);
    },
    toggleAssetLock: async (projectId, assetId) => {
      const ws = workspaces.get(projectId)!;
      const asset = ws.assets.find((a) => a.id === assetId)!;
      asset.lockedRef = !asset.lockedRef;
      return structuredClone(asset);
    },
    createShot: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      const shot: Shot = { id: `sh_${Date.now()}`, sceneId: input.sceneId, episodeId: input.episodeId, orderIndex: ws.shots.length, title: `镜 ${String(ws.shots.length + 1).padStart(2, "0")} · 新镜头`, scale: "中景", cameraMove: "固定", durationSec: 3, visualPrompt: "", negativePrompt: "", dialogue: "", speaker: "", subtitle: "", characterAssetIds: [], selectedImageTakeId: null, selectedVideoTakeId: null, selectedSpeechTakeId: null, updatedAt: new Date().toISOString() };
      ws.shots.push(shot);
      return structuredClone(shot);
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
        if (t.shotId === input.shotId && t.kind === input.kind) t.isSelected = t.id === input.takeId;
      }
      const shot = ws.shots.find((s) => s.id === input.shotId)!;
      if (input.kind === "image") shot.selectedImageTakeId = input.takeId;
      if (input.kind === "video") shot.selectedVideoTakeId = input.takeId;
      if (input.kind === "speech") shot.selectedSpeechTakeId = input.takeId;
      return structuredClone(ws);
    },
    addSyntheticTake: async (input) => {
      const ws = workspaces.get(input.projectId)!;
      const ver = ws.takes.filter((t) => t.shotId === input.shotId && t.kind === input.kind).length + 1;
      const id = `tk_${Date.now()}`;
      for (const t of ws.takes) if (t.shotId === input.shotId && t.kind === input.kind) t.isSelected = false;
      ws.takes.push({ id, shotId: input.shotId, kind: input.kind, versionNumber: ver, mediaPath: makeDemoSvgDataUrl(`版本 ${ver}`, "新候选画面", `版本 ${ver}`, "#111C1B", "#134E4A", "#10B981"), mediaSha256: null, promptSnapshot: "", providerInfo: "本地候选", isSelected: true, durationSec: null, createdAt: new Date().toISOString() });
      const shot = ws.shots.find((s) => s.id === input.shotId)!;
      if (input.kind === "image") shot.selectedImageTakeId = id;
      return structuredClone(ws);
    },
    exportProjectArchive: async () => ({ ok: true, message: "浏览器预览模式不写入磁盘" }),
    importProjectArchive: async () => ({ ok: false, message: "请在桌面端使用工程包导入" }),
    getModelCenter: async () => structuredClone(modelCenter),
    saveProviderConfig: async (input) => {
      const saved: ProviderConfigView = {
        id: input.id || `prv_${Date.now()}`,
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        models: input.models,
        hasSecret: Boolean(input.apiKey),
        keyHint: input.apiKey ? `••••${input.apiKey.slice(-4)}` : null,
        enabled: input.enabled,
        lastTestOk: null,
        lastTestMessage: null,
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
    getAppInfo: async () => ({ version: "1.0.0-alpha.1", workspaceRoot: "我的作品", sqliteEngine: "browser-preview", platform: "web" }),
    mediaUrl: (_projectId, relativePath) => relativePath,
  };
}

let cachedClient: AivoraDesktopApi | null = null;

export function getDesktopClient(): AivoraDesktopApi {
  if (typeof window !== "undefined" && window.aivora) return window.aivora;
  if (!cachedClient) cachedClient = createBrowserPreviewApi();
  return cachedClient;
}
