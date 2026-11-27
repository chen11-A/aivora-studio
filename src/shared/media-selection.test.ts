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
        scale: "远景", cameraMove: "固定", durationSec: 3, trimInSec: 0, trimOutSec: 0, visualPrompt: "", negativePrompt: "",
        dialogue: "", speaker: "", speakerAssetId: null, speakerStatus: "none", subtitle: "第一句", sourceSpan: null, keyBeat: false, keyBeatReason: "", videoPlanMode: "paid_video", characterAssetIds: [],
        selectedImageTakeId: "tk_img", selectedVideoTakeId: "tk_vid", selectedSpeechTakeId: null, updatedAt: now,
      },
      {
        id: "sh_2", sceneId: "sc_1", episodeId: "ep_1", orderIndex: 1, title: "镜02",
        scale: "近景", cameraMove: "固定", durationSec: 4, trimInSec: 0, trimOutSec: 0, visualPrompt: "", negativePrompt: "",
        dialogue: "", speaker: "", speakerAssetId: null, speakerStatus: "none", subtitle: "", sourceSpan: null, keyBeat: false, keyBeatReason: "", videoPlanMode: "paid_video", characterAssetIds: [],
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
    expect(readiness.blockingReason).toContain("缺少可用画面");
    expect(readiness.blockingReason).toContain("试片与正片");
  });

  it("distinguishes preview-ready from formal-blocked when dialogue has unconfirmed speaker or missing speech (F04)", () => {
    const ws = makeWorkspace();
    ws.takes.push({
      id: "tk_vid_2",
      shotId: "sh_2",
      kind: "video",
      versionNumber: 1,
      mediaPath: "assets/c.mp4",
      mediaSha256: null,
      promptSnapshot: "",
      providerInfo: "",
      isSelected: true,
      durationSec: 4,
      createdAt: ws.project.createdAt,
    });
    ws.shots[1]!.selectedVideoTakeId = "tk_vid_2";
    ws.shots[1]!.dialogue = "山门起风了。";
    ws.shots[1]!.speakerStatus = "unconfirmed";

    const readiness = evaluateEpisodeExportReadiness(ws, "ep_1");
    expect(readiness.canExport).toBe(true);
    expect(readiness.canFormalExport).toBe(false);
    expect(readiness.formalBlockingIssues.map((i) => i.reason)).toEqual([
      "说话人待确认",
      "有对白未配音",
    ]);
    expect(readiness.formalBlockingIssues[0]!.shotIndex).toBe(2);
  });

  it("does not misreport same-snapshot formal delivery with tech QC issues as stale/modified", async () => {
    const { computeEpisodeExportSnapshotDigest, deriveEpisodeDeliveryEligibility } = await import("./studio-truth");
    const ws = makeWorkspace();
    ws.takes.push({
      id: "tk_vid_2",
      shotId: "sh_2",
      kind: "video",
      versionNumber: 1,
      mediaPath: "assets/c.mp4",
      mediaSha256: null,
      promptSnapshot: "",
      providerInfo: "",
      isSelected: true,
      durationSec: 4,
      createdAt: ws.project.createdAt,
    });
    ws.shots[1]!.selectedVideoTakeId = "tk_vid_2";
    const digest = computeEpisodeExportSnapshotDigest(ws, "ep_1");

    ws.deliveryRecords = [
      {
        id: "del_same",
        projectId: "prj_1",
        episodeId: "ep_1",
        exportMode: "formal",
        status: "published",
        snapshotDigest: digest,
        outputPath: "/tmp/ep1.mp4",
        outputSha256: "abc",
        contentQcOk: true,
        techQcOk: false,
        createdAt: ws.project.createdAt,
        updatedAt: ws.project.createdAt,
      },
    ];
    const sameSnap = deriveEpisodeDeliveryEligibility({ workspace: ws, episodeId: "ep_1" });
    expect(sameSnap.reportStale).toBe(false);
    expect(sameSnap.reason).not.toContain("已修改");
    expect(sameSnap.reason).toContain("技术质检");

    ws.deliveryRecords![0]!.snapshotDigest = "older_digest_before_edit";
    const staleSnap = deriveEpisodeDeliveryEligibility({ workspace: ws, episodeId: "ep_1" });
    expect(staleSnap.reportStale).toBe(true);
    expect(staleSnap.reason).toContain("已修改");
  });
});
