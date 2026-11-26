import { createHash, randomUUID } from "node:crypto";
import type { ProjectWorkspace, SourceAnchor } from "../../shared/types/domain";
import type { DirectorProposal } from "../../shared/types/jobs";

/**
 * Computes exact SHA-256 of the persisted episode shooting script.
 * Intentionally does NOT trim or normalize whitespace so even trailing-space or
 * newline edits invalidate stale proposals (F01).
 */
export function computeScriptSha256(scriptText: string): string {
  return createHash("sha256").update(scriptText, "utf8").digest("hex");
}

/**
 * Separate digest for original-novel evidence anchors so source excerpts are
 * tracked independently from the editable shooting script content (F01).
 */
export function computeSourceEvidenceDigest(sourceAnchors: SourceAnchor[]): string {
  const normalized = [...sourceAnchors]
    .map((a) => ({ paragraphIndex: a.paragraphIndex, excerpt: a.excerpt }))
    .sort((a, b) => a.paragraphIndex - b.paragraphIndex || a.excerpt.localeCompare(b.excerpt));
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

/**
 * Computes deterministic SHA-256 of all effective episode dependencies so reverting
 * the script text back to its original wording still detects changes in assets,
 * locks, scenes, shots, takes, trims, or subtitles (F01).
 */
export function computeEpisodeDependencySha256(
  workspace: ProjectWorkspace,
  episodeId: string,
): string {
  const assets = workspace.assets
    .filter((a) => a.kind === "character" || a.kind === "scene" || a.kind === "prop")
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      name: a.name,
      description: a.description,
      lockedRef: a.lockedRef,
      mediaSha256: a.mediaSha256,
      voiceId: a.voiceId,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const scenes = workspace.scenes
    .filter((s) => s.episodeId === episodeId)
    .map((s) => ({
      id: s.id,
      orderIndex: s.orderIndex,
      title: s.title,
      locationAssetId: s.locationAssetId,
      paragraphStart: s.paragraphStart,
      paragraphEnd: s.paragraphEnd,
      sourceAnchor: s.sourceAnchor ?? null,
    }))
    .sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id));

  const shots = workspace.shots
    .filter((s) => s.episodeId === episodeId)
    .map((s) => ({
      id: s.id,
      sceneId: s.sceneId,
      orderIndex: s.orderIndex,
      sourceAnchor: s.sourceAnchor ?? null,
      sourceSpan: s.sourceSpan ?? null,
      selectedImageTakeId: s.selectedImageTakeId,
      selectedVideoTakeId: s.selectedVideoTakeId,
      selectedSpeechTakeId: s.selectedSpeechTakeId,
      trimInSec: s.trimInSec,
      trimOutSec: s.trimOutSec,
      subtitle: s.subtitle,
      dialogue: s.dialogue,
      speaker: s.speaker,
      speakerStatus: s.speakerStatus,
      characterAssetIds: [...s.characterAssetIds],
    }))
    .sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id));

  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId: workspace.project.id,
        episodeId,
        aspectRatio: workspace.project.aspectRatio,
        stylePreset: workspace.project.stylePreset,
        assets,
        scenes,
        shots,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Stamps trustworthy main-process provenance & snapshot hashes onto a DirectorProposal.
 */
export function stampDirectorProposalSnapshot(
  workspace: ProjectWorkspace,
  episodeId: string,
  proposal: DirectorProposal,
): DirectorProposal {
  const ep = workspace.episodes.find((e) => e.id === episodeId);
  if (!ep) {
    throw new Error("目标分集不存在，无法生成提案快照");
  }
  return {
    ...proposal,
    proposalId: proposal.proposalId?.trim() || `prop_${randomUUID().replaceAll("-", "").slice(0, 14)}`,
    targetProjectId: workspace.project.id,
    targetEpisodeId: ep.id,
    targetEpisodeTitle: ep.title,
    targetScriptSha256: computeScriptSha256(ep.scriptText),
    targetDependencySha256: computeEpisodeDependencySha256(workspace, ep.id),
    sourceEvidenceDigest: computeSourceEvidenceDigest(ep.sourceAnchors ?? []),
  };
}
