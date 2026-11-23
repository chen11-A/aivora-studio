import { describe, expect, it } from "vitest";
import {
  evaluateEpisodeExportReadiness,
  resolveActiveVisualTake,
} from "./media-selection";
import type { ProjectWorkspace } from "./types/domain";

function makeWorkspace(): ProjectWorkspace {
  const now = new Date().toISOString();
  return {
    dirPath: "/tmp/demo",
    project: {
      id: "prj_1",
      name: "测试剧",
      aspectRatio: "16:9",
      stylePreset: "电影",
      coverAssetPath: null,
      subtitleStyle: "white",
      loudnessNormalize: true,
      bgmAssetId: null,
      bgmVolumeDb: -14,
      createdAt: now,
      updatedAt: now,
    },
    episodes: [
      { id: "ep_1", projectId: "prj_1", orderIndex: 0, title: "第1集", scriptText: "", sourceAnchors: [], updatedAt: now },
    ],
    assets: [],
    scenes: [{ id: "sc_1", episodeId: "ep_1", orderIndex: 0, title: "场1", locationAssetId: null, summary: "", paragraphStart: 0, paragraphEnd: 0 }],
    shots: [
      {
        id: "sh_1", sceneId: "sc_1", episodeId: "ep_1", orderIndex: 0, title: "镜01",
        scale: "远景", cameraMove: "固定", durationSec: 3, visualPrompt: "", negativePrompt: "",
        dialogue: "", speaker: "", subtitle: "第一句", characterAssetIds: [],
        selectedImageTakeId: "tk_img", selectedVideoTakeId: "tk_vid", selectedSpeechTakeId: null, updatedAt: now,
      },
      {
        id: "sh_2", sceneId: "sc_1", episodeId: "ep_1", orderIndex: 1, title: "镜02",
        scale: "近景", cameraMove: "固定", durationSec: 4, visualPrompt: "", negativePrompt: "",
        dialogue: "", speaker: "", subtitle: "", characterAssetIds: [],
        selectedImageTakeId: null, selectedVideoTakeId: null, selectedSpeechTakeId: null, updatedAt: now,
      },
    ],
    takes: [
      { id: "tk_img", shotId: "sh_1", kind: "image", versionNumber: 1, mediaPath: "assets/a.png", mediaSha256: null, promptSnapshot: "", providerInfo: "", isSelected: false, durationSec: null, createdAt: now },
      { id: "tk_vid", shotId: "sh_1", kind: "video", versionNumber: 2, mediaPath: "assets/b.mp4", mediaSha256: null, promptSnapshot: "", providerInfo: "", isSelected: true, durationSec: 3, createdAt: now },
    ],
    jobs: [],
  };
}

describe("media-selection & export readiness", () => {
  it("prioritizes selected video take over image take and detects missing visual shots", () => {
    const ws = makeWorkspace();
    const active = resolveActiveVisualTake(ws.shots[0]!, ws.takes);
    expect(active?.id).toBe("tk_vid");

    const readiness = evaluateEpisodeExportReadiness(ws, "ep_1");
    expect(readiness.canExport).toBe(false);
    expect(readiness.visualReadyCount).toBe(1);
    expect(readiness.realVideoCount).toBe(1);
    expect(readiness.missingVisualShots).toEqual([{ id: "sh_2", title: "镜02" }]);
    expect(readiness.blockingReason).toContain("1 个镜头缺少可用画面版本");
  });
});
