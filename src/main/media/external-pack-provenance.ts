import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProjectWorkspace, Shot } from "../../shared/types/domain";
import { parseShotIndexFromFilename } from "./external-pack";

export type ExternalPackProvenanceState =
  | "planned"
  | "verified_sent"
  | "self_reported"
  | "unknown";

export type ExternalPackManifestShot = {
  index: number;
  shotId: string;
  title: string;
  shotDigest: string;
};

export type ExternalPackManifest = {
  schemaVersion: "aivora-external-pack/2.0";
  packVersion: string;
  projectId: string;
  projectName: string;
  episodeId: string;
  episodeTitle: string;
  provenanceState: ExternalPackProvenanceState;
  exportedAt: string;
  shots: ExternalPackManifestShot[];
};

export type ProvenanceMatchDecision = {
  filePath: string;
  fileName: string;
  status: "matched" | "manual_review" | "unmatched";
  matchedShotId: string | null;
  provenanceState: ExternalPackProvenanceState;
  reason: string;
};

export function computeShotPackDigest(shot: Shot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: shot.id,
        title: shot.title,
        visualPrompt: shot.visualPrompt,
        durationSec: shot.durationSec,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

export function writeExternalPackManifest(input: {
  packDir: string;
  workspace: ProjectWorkspace;
  episodeId: string;
  provenanceState?: ExternalPackProvenanceState;
}): ExternalPackManifest {
  const episode = input.workspace.episodes.find((e) => e.id === input.episodeId);
  if (!episode) throw new Error("找不到分集");
  const epShots = input.workspace.shots
    .filter((s) => s.episodeId === input.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);

  const shots: ExternalPackManifestShot[] = epShots.map((s, idx) => ({
    index: idx + 1,
    shotId: s.id,
    title: s.title,
    shotDigest: computeShotPackDigest(s),
  }));
  const packVersion = createHash("sha256")
    .update(
      JSON.stringify({
        projectId: input.workspace.project.id,
        episodeId: episode.id,
        shots: shots.map((s) => `${s.index}:${s.shotId}:${s.shotDigest}`),
      }),
    )
    .digest("hex")
    .slice(0, 16);

  const manifest: ExternalPackManifest = {
    schemaVersion: "aivora-external-pack/2.0",
    packVersion,
    projectId: input.workspace.project.id,
    projectName: input.workspace.project.name,
    episodeId: episode.id,
    episodeTitle: episode.title,
    provenanceState: input.provenanceState ?? "planned",
    exportedAt: new Date().toISOString(),
    shots,
  };
  writeFileSync(path.join(input.packDir, "pack-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

export function readExternalPackManifest(folderDir: string): ExternalPackManifest | null {
  const candidates = [
    path.join(folderDir, "pack-manifest.json"),
    path.join(path.dirname(folderDir), "pack-manifest.json"),
  ];
  for (const fp of candidates) {
    if (!existsSync(fp)) continue;
    try {
      const parsed = JSON.parse(readFileSync(fp, "utf8")) as ExternalPackManifest;
      if (parsed.schemaVersion === "aivora-external-pack/2.0" && parsed.projectId && parsed.episodeId) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * F13 Provenance-Aware Drop Matching:
 * - Strictly checks `projectId + episodeId + shotId + packVersion` against `pack-manifest.json`.
 * - If a pack belongs to a DIFFERENT project (even with the exact same project name!), routes ALL files
 *   to `manual_review` with `provenanceState: "unknown"` and NEVER auto-binds them!
 * - If shots were reordered/changed after export so old `03.mp4` no longer matches current Shot 3's ID/digest,
 *   routes it to `manual_review` instead of binding to the wrong shot or touching confirmed takes!
 */
export function matchExternalDropWithProvenance(input: {
  workspace: ProjectWorkspace;
  episodeId: string;
  folderDir: string;
  filePaths: string[];
  declaredProvenance?: ExternalPackProvenanceState;
}): ProvenanceMatchDecision[] {
  const manifest = readExternalPackManifest(input.folderDir);
  const currentShots = input.workspace.shots
    .filter((s) => s.episodeId === input.episodeId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const currentById = new Map(currentShots.map((s, idx) => [s.id, { shot: s, index: idx + 1 }]));

  const decisions: ProvenanceMatchDecision[] = [];

  for (const filePath of input.filePaths) {
    const fileName = path.basename(filePath);

    // 1. Cross-project / same-name different-ID guard
    if (manifest && (manifest.projectId !== input.workspace.project.id || manifest.episodeId !== input.episodeId)) {
      decisions.push({
        filePath,
        fileName,
        status: "manual_review",
        matchedShotId: null,
        provenanceState: "unknown",
        reason: `外采包来源工程/分集不匹配（包内工程「${manifest.projectName}」ID ${manifest.projectId} ≠ 当前工程 ID ${input.workspace.project.id}），已转入人工核对，绝不自动入库或覆盖定稿。`,
      });
      continue;
    }

    const idx = parseShotIndexFromFilename(fileName);
    if (idx === null) {
      decisions.push({
        filePath,
        fileName,
        status: "unmatched",
        matchedShotId: null,
        provenanceState: input.declaredProvenance ?? "unknown",
        reason: "文件名不含镜头编号，请人工指定归属镜头（仅新增候选，不覆盖定稿）。",
      });
      continue;
    }

    if (manifest) {
      const manifestShot = manifest.shots.find((s) => s.index === idx);
      if (!manifestShot) {
        decisions.push({
          filePath,
          fileName,
          status: "manual_review",
          matchedShotId: null,
          provenanceState: "unknown",
          reason: `外采清单中找不到第 ${idx} 镜记录，已转入人工核对。`,
        });
        continue;
      }
      const curEntry = currentById.get(manifestShot.shotId);
      if (!curEntry) {
        decisions.push({
          filePath,
          fileName,
          status: "manual_review",
          matchedShotId: null,
          provenanceState: "unknown",
          reason: `原第 ${idx} 镜（ID ${manifestShot.shotId}）在当前分集中已删除，已转入人工核对。`,
        });
        continue;
      }
      // Reordered shot guard: old `03.mp4` when Shot 3 moved to position 1 or another shot is now #3!
      if (curEntry.index !== idx) {
        decisions.push({
          filePath,
          fileName,
          status: "manual_review",
          matchedShotId: null,
          provenanceState: manifest.provenanceState,
          reason: `镜头顺序在外采后已调整（原第 ${idx} 镜「${manifestShot.title}」现位于第 ${curEntry.index} 位），为防错配已转入人工核对，不触碰任何定稿。`,
        });
        continue;
      }
      if (computeShotPackDigest(curEntry.shot) !== manifestShot.shotDigest) {
        decisions.push({
          filePath,
          fileName,
          status: "manual_review",
          matchedShotId: null,
          provenanceState: manifest.provenanceState,
          reason: `第 ${idx} 镜在外采后提示词或时长已修改（版本摘要变化），已转入人工核对，确认后可作为候选入库。`,
        });
        continue;
      }
      decisions.push({
        filePath,
        fileName,
        status: "matched",
        matchedShotId: curEntry.shot.id,
        provenanceState: input.declaredProvenance ?? manifest.provenanceState,
        reason: `ID 与版本摘要核验一致（${curEntry.shot.title}），将保存为候选版本。`,
      });
      continue;
    }

    // No manifest present: self_reported / unknown provenance -> NEVER blindly trust index if caller requires strict review, or label self_reported
    const fallbackShot = currentShots[idx - 1];
    decisions.push({
      filePath,
      fileName,
      status: fallbackShot ? "manual_review" : "unmatched",
      matchedShotId: null,
      provenanceState: input.declaredProvenance ?? "self_reported",
      reason: fallbackShot
        ? `缺少 pack-manifest.json 来源清单（自报编号 ${idx}），已转入人工确认以防同名/改序错配。`
        : `未找到编号 ${idx} 对应镜头。`,
    });
  }

  return decisions;
}
