import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { BuiltinBgmTrack } from "../../shared/ipc-contract";

type RawManifestTrack = {
  id: string;
  name: string;
  mood: string;
  scene: string;
  durationSec: number;
  loudnessLufs: number;
  truePeakDbtp: number;
  license: string;
  author: string;
  sourceUrl: string;
  sha256: string;
  file: string;
};

type RawAudioManifest = {
  version: number;
  license: string;
  tracks: RawManifestTrack[];
};

export const BUILTIN_MEDIA_HOST = "__builtin__";

export function resolveBuiltinAudioRoot(): string | null {
  const candidates: string[] = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "audio"));
  }
  candidates.push(path.resolve(process.cwd(), "resources", "audio"));
  candidates.push(path.resolve(__dirname, "../../../resources/audio"));

  for (const dir of candidates) {
    if (existsSync(path.join(dir, "manifest.json"))) {
      return dir;
    }
  }
  return null;
}

export function listBuiltinBgmTracks(audioRoot?: string | null): BuiltinBgmTrack[] {
  const root = audioRoot ?? resolveBuiltinAudioRoot();
  if (!root) return [];
  const manifestPath = path.join(root, "manifest.json");
  if (!existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as RawAudioManifest;
    if (!Array.isArray(parsed.tracks)) return [];
    const out: BuiltinBgmTrack[] = [];
    for (const t of parsed.tracks) {
      const fileName = path.basename(t.file);
      const abs = path.join(root, "music", fileName);
      if (!existsSync(abs)) continue;
      out.push({
        id: t.id,
        name: t.name,
        mood: t.mood,
        scene: t.scene,
        durationSec: t.durationSec,
        loudnessLufs: t.loudnessLufs,
        truePeakDbtp: t.truePeakDbtp,
        license: t.license,
        author: t.author,
        sourceUrl: t.sourceUrl,
        sha256: t.sha256,
        file: `music/${fileName}`,
        previewUrl: `aivora-media://${BUILTIN_MEDIA_HOST}/audio/music/${encodeURIComponent(fileName)}`,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function resolveBuiltinBgmTrackFile(
  trackId: string,
  audioRoot?: string | null,
): { track: BuiltinBgmTrack; filePath: string } | null {
  const root = audioRoot ?? resolveBuiltinAudioRoot();
  if (!root) return null;
  const tracks = listBuiltinBgmTracks(root);
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const abs = resolveConfinedBuiltinAudioPath(`audio/${track.file}`, root);
  if (!abs) return null;
  return { track, filePath: abs };
}

/**
 * Confines `aivora-media://__builtin__/audio/music/<file>.ogg` strictly to
 * `<audioRoot>/music/` with symlink, traversal, and extension checks.
 */
export function resolveConfinedBuiltinAudioPath(
  relPath: string,
  audioRoot?: string | null,
): string | null {
  const root = audioRoot ?? resolveBuiltinAudioRoot();
  if (!root || !relPath || relPath.length > 260 || /[\0\r\n\\]/.test(relPath)) return null;
  const normalized = relPath.replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (parts.length !== 3 || parts[0] !== "audio" || parts[1] !== "music") return null;
  const fileName = parts[2]!;
  if (!fileName || fileName === "." || fileName === ".." || !fileName.toLowerCase().endsWith(".ogg")) {
    return null;
  }

  let canonicalMusicDir: string;
  try {
    canonicalMusicDir = realpathSync.native(path.join(root, "music"));
  } catch {
    return null;
  }
  const target = path.join(canonicalMusicDir, fileName);
  try {
    if (lstatSync(target).isSymbolicLink()) return null;
    const canonicalFile = realpathSync.native(target);
    const rel = path.relative(canonicalMusicDir, canonicalFile);
    if (!rel || path.isAbsolute(rel) || rel.includes("..") || rel.includes(path.sep)) return null;
    if (!lstatSync(canonicalFile).isFile()) return null;
    return canonicalFile;
  } catch {
    return null;
  }
}
