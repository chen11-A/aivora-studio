import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  buildSceneShotRanges,
  inferSceneMood,
  resolveEffectiveEpisodeBgmCues,
} from "../../shared/bgm-cues";
import {
  EpisodeBgmCueSchema,
  type EpisodeBgmCue,
  type ProjectWorkspace,
} from "../../shared/types/domain";
import { listBuiltinBgmTracks, resolveBuiltinBgmTrackFile } from "../media/builtin-audio";
import type { ProjectStore } from "./project-store";

const ALLOWED_AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
const EpisodeBgmCueArraySchema = z.array(EpisodeBgmCueSchema).max(64);

/**
 * Ensures an audio file exists as a `music` asset in the project (deduplicated by SHA-256),
 * returning its `assetId` without clobbering `projects.bgm_asset_id`.
 */
export function ensureMusicAssetFromFile(
  projects: ProjectStore,
  input: {
    projectId: string;
    sourceFilePath: string;
    displayName?: string;
    description?: string;
  },
): { assetId: string; created: boolean } {
  const projectDir = projects.resolveProjectDir(input.projectId);
  if (!projectDir) throw new Error("作品目录不存在");

  const abs = path.resolve(input.sourceFilePath);
  const ext = path.extname(abs).toLowerCase();
  if (!ALLOWED_AUDIO_EXTS.has(ext)) {
    throw new Error(`不支持的音频文件格式：${ext || "(无扩展名)"}`);
  }
  const buf = readFileSync(abs);
  const sha = createHash("sha256").update(buf).digest("hex");

  let result: { assetId: string; created: boolean } | null = null;
  projects.withProjectDb(input.projectId, (db) => {
    const existing = db.get<{ id: string }>(
      `SELECT id FROM assets WHERE project_id = ? AND kind = 'music' AND media_sha256 = ? LIMIT 1`,
      input.projectId,
      sha,
    );
    if (existing) {
      result = { assetId: existing.id, created: false };
      return;
    }

    const fileName = `${sha.slice(0, 16)}${ext}`;
    const assetsDir = path.join(projectDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    copyFileSync(abs, path.join(assetsDir, fileName));

    const now = new Date().toISOString();
    const assetId = `bgm_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const baseName = path.basename(abs, ext);
    db.transaction(() => {
      db.run(
        `INSERT INTO assets (id, project_id, kind, name, description, media_path, media_sha256, locked_ref, voice_id, updated_at)
         VALUES (?, ?, 'music', ?, ?, ?, ?, 0, NULL, ?)`,
        assetId,
        input.projectId,
        input.displayName?.trim() || baseName || "背景音乐",
        input.description?.trim() || "本剧配乐库素材",
        `assets/${fileName}`,
        sha,
        now,
      );
      db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
    });
    result = { assetId, created: true };
  });

  if (!result) throw new Error("写入音乐资产失败");
  return result;
}

export function saveEpisodeBgmCues(
  projects: ProjectStore,
  input: {
    projectId: string;
    episodeId: string;
    bgmCues: EpisodeBgmCue[];
  },
): ProjectWorkspace {
  const parsed = EpisodeBgmCueArraySchema.parse(input.bgmCues);
  const normalized = parsed
    .map((c) => ({
      ...c,
      endShotIndex: Math.max(c.startShotIndex, c.endShotIndex),
    }))
    .sort((a, b) => a.startShotIndex - b.startShotIndex || a.endShotIndex - b.endShotIndex);

  const now = new Date().toISOString();
  projects.withProjectDb(input.projectId, (db) => {
    const ep = db.get<{ id: string }>(`SELECT id FROM episodes WHERE id = ?`, input.episodeId);
    if (!ep) throw new Error("分集不存在");
    db.transaction(() => {
      db.run(
        `UPDATE episodes SET bgm_cues_json = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(normalized),
        now,
        input.episodeId,
      );
      db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
    });
  });

  return projects.openProject(input.projectId);
}

/**
 * Automatically plans per-scene mood-matched BGM cues for an episode using the bundled
 * CC0 music library (deduplicated into the project's reusable music library).
 */
export function autoPlanEpisodeBgmCues(
  projects: ProjectStore,
  input: { projectId: string; episodeId: string; audioRoot?: string | null },
): { ok: boolean; workspace?: ProjectWorkspace; cues: EpisodeBgmCue[]; message: string } {
  const ws = projects.openProject(input.projectId);
  const epShots = ws.shots
    .filter((s) => s.episodeId === input.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  if (epShots.length === 0) {
    return { ok: false, cues: [], message: "当前分集还没有镜头，无法自动排布配乐。" };
  }

  const epScenes = ws.scenes
    .filter((sc) => sc.episodeId === input.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const builtinTracks = listBuiltinBgmTracks(input.audioRoot);
  const ranges = buildSceneShotRanges(epShots, epScenes);

  const cues: EpisodeBgmCue[] = [];
  const moodNames: string[] = [];

  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i]!;
    const mood = inferSceneMood(`${ws.project.stylePreset} ${range.text}`);
    moodNames.push(mood);

    let chosenAssetId: string | null = null;
    const matchedBuiltin =
      builtinTracks.find((t) => t.mood === mood) ??
      builtinTracks[i % Math.max(1, builtinTracks.length)] ??
      null;

    if (matchedBuiltin) {
      const resolved = resolveBuiltinBgmTrackFile(matchedBuiltin.id, input.audioRoot);
      if (resolved) {
        const ensured = ensureMusicAssetFromFile(projects, {
          projectId: input.projectId,
          sourceFilePath: resolved.filePath,
          displayName: `内置配乐 · ${resolved.track.name}（${resolved.track.mood} · ${resolved.track.license}）`,
          description: `${resolved.track.scene} 作者：${resolved.track.author}，许可：${resolved.track.license}`,
        });
        chosenAssetId = ensured.assetId;
      }
    } else if (ws.project.bgmAssetId) {
      chosenAssetId = ws.project.bgmAssetId;
    }

    cues.push({
      id: `cue_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      startShotIndex: range.startShotIndex,
      endShotIndex: range.endShotIndex,
      assetId: chosenAssetId,
      mood,
      // On second+ scenes, skip slow 12s intro so music enters cleanly into melodic pulse
      startOffsetSec: i > 0 ? 12 : 0,
      volumeDb: -14,
      fadeInSec: i === 0 ? 0.8 : 1.0,
      fadeOutSec: i === ranges.length - 1 ? 1.8 : 1.2,
    });
  }

  const updated = saveEpisodeBgmCues(projects, {
    projectId: input.projectId,
    episodeId: input.episodeId,
    bgmCues: cues,
  });

  return {
    ok: true,
    workspace: updated,
    cues,
    message: `已按 ${cues.length} 个场次自动铺设分段配乐（情绪：${moodNames.join(" → ")}），可随时在时间轴微调起播点与留白`,
  };
}

/**
 * Applies a built-in CC0 track either to a specific episode cue (`episodeId` + `cueId`),
 * or to the active project default BGM when no specific cue is targeted.
 */
export function applyBuiltinTrackToTarget(
  projects: ProjectStore,
  input: {
    projectId: string;
    trackId: string;
    episodeId?: string;
    cueId?: string;
    audioRoot?: string | null;
  },
): { ok: boolean; projectId: string; workspace?: ProjectWorkspace; assetId?: string; message: string } {
  const resolved = resolveBuiltinBgmTrackFile(input.trackId, input.audioRoot);
  if (!resolved) {
    return { ok: false, projectId: input.projectId, message: "找不到指定的内置精选配乐" };
  }
  const ensured = ensureMusicAssetFromFile(projects, {
    projectId: input.projectId,
    sourceFilePath: resolved.filePath,
    displayName: `内置配乐 · ${resolved.track.name}（${resolved.track.mood} · ${resolved.track.license}）`,
    description: `${resolved.track.scene} 作者：${resolved.track.author}，许可：${resolved.track.license}`,
  });

  if (input.episodeId) {
    const ws = projects.openProject(input.projectId);
    const epShots = ws.shots
      .filter((s) => s.episodeId === input.episodeId)
      .sort((a, b) => a.orderIndex - b.orderIndex);
    const existing = resolveEffectiveEpisodeBgmCues(ws, input.episodeId, epShots.length);

    let nextCues: EpisodeBgmCue[];
    if (input.cueId && existing.some((c) => c.id === input.cueId)) {
      nextCues = existing.map((c) =>
        c.id === input.cueId
          ? { ...c, assetId: ensured.assetId, mood: resolved.track.mood }
          : c,
      );
    } else if (existing.length > 0 && !input.cueId) {
      nextCues = existing.map((c, idx) =>
        idx === 0 ? { ...c, assetId: ensured.assetId, mood: resolved.track.mood } : c,
      );
    } else {
      nextCues = [
        {
          id: `cue_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
          startShotIndex: 0,
          endShotIndex: Math.max(0, epShots.length - 1),
          assetId: ensured.assetId,
          mood: resolved.track.mood,
          startOffsetSec: 0,
          volumeDb: ws.project.bgmVolumeDb,
          fadeInSec: 0.8,
          fadeOutSec: 1.5,
        },
      ];
    }
    const workspace = saveEpisodeBgmCues(projects, {
      projectId: input.projectId,
      episodeId: input.episodeId,
      bgmCues: nextCues,
    });
    return {
      ok: true,
      projectId: input.projectId,
      workspace,
      assetId: ensured.assetId,
      message: `已将内置无版权配乐「${resolved.track.name}」套用到所选配乐段`,
    };
  }

  // Legacy project-wide default BGM fallback
  const now = new Date().toISOString();
  projects.withProjectDb(input.projectId, (db) => {
    db.run(
      `UPDATE projects SET bgm_asset_id = ?, updated_at = ? WHERE id = ?`,
      ensured.assetId,
      now,
      input.projectId,
    );
  });
  return {
    ok: true,
    projectId: input.projectId,
    workspace: projects.openProject(input.projectId),
    assetId: ensured.assetId,
    message: `已采用内置无版权配乐「${resolved.track.name}」并拷贝至当前作品目录`,
  };
}
