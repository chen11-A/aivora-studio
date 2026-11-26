import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CreateProjectInputSchema,
  UpdateEpisodeInputSchema,
  UpdateProjectSettingsInputSchema,
  type Asset,
  type AssetKind,
  type CreateProjectInput,
  type Episode,
  type ProjectSummary,
  type ProjectWorkspace,
  type Shot,
  type TakeKind,
  type UpdateAssetInput,
  type UpdateEpisodeInput,
  type UpdateProjectSettingsInput,
  type UpdateShotInput,
} from "../../shared/types/domain";
import { DEMO_SCRIPT_EP1, populateDemoProject, writeCinematicFrameSvg } from "./demo-seed";
import { ExclusiveAssetFileTracker } from "./exclusive-file-staging";
import {
  applyProjectBgmAssetInDb, deleteProjectBgmCandidateInDb, importAssetImageInDb,
  importProjectBgmInDb, importShotTakeInDb, parseCandidatePaths,
  registerProjectBgmCandidateInDb, selectAssetCandidateInDb, updateAssetInDb,
} from "./media-import";
import { exportProjectArchive, importProjectArchive } from "./project-archive";
import { cleanUnreferencedAssetsInProject } from "./project-maintenance";
import { readWorkspaceFromDb } from "./project-reader";
import { initProjectSchema } from "./schema";
import {
  addSyntheticTakeInDb,
  createShotInDb,
  deleteShotInDb,
  moveShotInDb,
  selectTakeInDb,
  updateShotInDb,
} from "./shot-mutations";
import { openSqlite, type SqliteDriver } from "./sqlite-driver";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function stripControlChars(value: string): string {
  return Array.from(value, (ch) => (ch.charCodeAt(0) < 32 ? "_" : ch)).join("");
}

export function safeFolderSegment(name: string): string {
  const cleaned = stripControlChars(name.normalize("NFC"))
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 64);
  if (!cleaned || WINDOWS_RESERVED.test(cleaned)) {
    return `作品_${randomUUID().slice(0, 6)}`;
  }
  return cleaned;
}

export class ProjectStore {
  private readonly dirByProjectId = new Map<string, string>();
  private readonly openDbs = new Map<string, SqliteDriver>();

  constructor(private readonly workspaceRoot: string) {
    mkdirSync(this.workspaceRoot, { recursive: true });
    this.scanProjects();
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  resolveProjectDir(projectId: string): string | null {
    const cached = this.dirByProjectId.get(projectId);
    if (cached && existsSync(join(cached, "project.db"))) return cached;
    this.scanProjects();
    return this.dirByProjectId.get(projectId) ?? null;
  }

  withProjectDb<T>(projectId: string, fn: (db: SqliteDriver, dirPath: string) => T): T {
    const dir = this.resolveProjectDir(projectId);
    if (!dir) throw new Error("找不到指定作品目录");
    return fn(this.getDb(projectId), dir);
  }

  private getDb(projectId: string): SqliteDriver {
    const existing = this.openDbs.get(projectId);
    if (existing) return existing;
    const dir = this.resolveProjectDir(projectId);
    if (!dir) throw new Error("找不到指定作品目录");
    const db = openSqlite(join(dir, "project.db"));
    initProjectSchema(db, dir);
    this.openDbs.set(projectId, db);
    return db;
  }

  private scanProjects(): void {
    this.dirByProjectId.clear();
    if (!existsSync(this.workspaceRoot)) return;
    for (const entry of readdirSync(this.workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(this.workspaceRoot, entry.name);
      const dbFile = join(dir, "project.db");
      if (!existsSync(dbFile)) continue;
      try {
        const db = openSqlite(dbFile, { readOnly: true });
        try {
          const row = db.get<{ id: string }>(`SELECT id FROM projects LIMIT 1`);
          if (row?.id) this.dirByProjectId.set(row.id, dir);
        } finally {
          db.close();
        }
      } catch {
        // Ignore unreadable or non-AIVORA directories.
      }
    }
  }

  listProjects(): ProjectSummary[] {
    this.scanProjects();
    const summaries: ProjectSummary[] = [];
    for (const [id, dirPath] of this.dirByProjectId.entries()) {
      const db = this.getDb(id);
      const proj = db.get<Record<string, unknown>>(`SELECT * FROM projects WHERE id = ?`, id);
      if (!proj) continue;
      const epCount = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM episodes`)?.c ?? 0;
      const shotCount = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM shots`)?.c ?? 0;
      summaries.push({
        id: String(proj.id),
        name: String(proj.name),
        dirPath,
        aspectRatio: proj.aspect_ratio === "9:16" ? "9:16" : "16:9",
        stylePreset: String(proj.style_preset ?? ""),
        coverAssetPath: proj.cover_asset_path ? String(proj.cover_asset_path) : null,
        episodeCount: Number(epCount),
        shotCount: Number(shotCount),
        createdAt: String(proj.created_at),
        updatedAt: String(proj.updated_at),
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createProject(rawInput: CreateProjectInput): ProjectWorkspace {
    const input = CreateProjectInputSchema.parse(rawInput);
    const id = `prj_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const now = new Date().toISOString();
    const baseFolder = safeFolderSegment(input.name);
    let dirPath = join(this.workspaceRoot, baseFolder);
    if (existsSync(dirPath)) dirPath = join(this.workspaceRoot, `${baseFolder}_${id.slice(-4)}`);
    mkdirSync(join(dirPath, "assets"), { recursive: true });
    mkdirSync(join(dirPath, "exports"), { recursive: true });

    const cover = writeCinematicFrameSvg(dirPath, {
      title: input.name,
      subtitle: "点击进入剧本与分镜创作",
      tag: `${input.aspectRatio} 新建作品`,
      palette: ["#111827", "#1E293B", "#3B82F6"],
      aspectRatio: input.aspectRatio,
    });

    const db = openSqlite(join(dirPath, "project.db"));
    initProjectSchema(db);
    this.openDbs.set(id, db);
    this.dirByProjectId.set(id, dirPath);

    const epId = `ep_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const scId = `sc_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const shotId = `sh_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const takeId = `tk_${randomUUID().replaceAll("-", "").slice(0, 10)}`;

    db.transaction(() => {
      db.run(
        `INSERT INTO projects (id, name, aspect_ratio, style_preset, cover_asset_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.name,
        input.aspectRatio,
        input.stylePreset || "胶片电影感 · 温暖写实",
        cover.mediaPath,
        now,
        now,
      );
      db.run(
        `INSERT INTO episodes (id, project_id, order_index, title, script_text, source_anchors_json, updated_at)
         VALUES (?, ?, 0, '第 1 集', ?, '[]', ?)`,
        epId,
        id,
        input.initialScript ?? "",
        now,
      );
      db.run(
        `INSERT INTO scenes (id, episode_id, order_index, title, summary) VALUES (?, ?, 0, '第一场 · 开场镜头', '故事开篇场景')`,
        scId,
        epId,
      );
      db.run(
        `INSERT INTO shots (id, scene_id, episode_id, order_index, title, scale, camera_move, duration_sec, visual_prompt, dialogue, speaker, subtitle, selected_image_take_id, updated_at)
         VALUES (?, ?, ?, 0, '镜 01 · 开场定场', '全景', '缓推', 4, ?, '', '', '', ?, ?)`,
        shotId,
        scId,
        epId,
        `${input.name} 开场画面，电影光影构图`,
        takeId,
        now,
      );
      db.run(
        `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, created_at)
         VALUES (?, ?, 'image', 1, ?, ?, ?, '初始画板', 1, ?)`,
        takeId,
        shotId,
        cover.mediaPath,
        cover.mediaSha256,
        `${input.name} 开场画面`,
        now,
      );
    });

    return this.openProject(id);
  }

  openDemoProject(): ProjectWorkspace {
    const existing = this.listProjects().find((p) => p.name === "晚照书店");
    if (existing) return this.openProject(existing.id);
    const created = this.createProject({
      name: "晚照书店",
      aspectRatio: "16:9",
      stylePreset: "胶片电影感 · 暖金黄昏",
      initialScript: DEMO_SCRIPT_EP1,
    });
    populateDemoProject(this.getDb(created.project.id), created);
    return this.openProject(created.project.id);
  }

  openProject(projectId: string): ProjectWorkspace {
    const dirPath = this.resolveProjectDir(projectId);
    if (!dirPath) throw new Error("作品不存在或目录已移动");
    return readWorkspaceFromDb(this.getDb(projectId), projectId, dirPath);
  }

  deleteProject(projectId: string): void {
    const dir = this.resolveProjectDir(projectId);
    const db = this.openDbs.get(projectId);
    if (db) {
      db.close();
      this.openDbs.delete(projectId);
    }
    this.dirByProjectId.delete(projectId);
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  updateProjectSettings(rawInput: UpdateProjectSettingsInput): ProjectWorkspace {
    const input = UpdateProjectSettingsInputSchema.parse(rawInput);
    const db = this.getDb(input.projectId);
    const now = new Date().toISOString();
    db.transaction(() => {
      const current = db.get<Record<string, unknown>>(`SELECT * FROM projects WHERE id = ?`, input.projectId);
      if (!current) throw new Error("作品不存在");
      db.run(
        `UPDATE projects SET name = ?, aspect_ratio = ?, style_preset = ?, subtitle_style = ?,
         loudness_normalize = ?, bgm_asset_id = ?, bgm_volume_db = ?, updated_at = ? WHERE id = ?`,
        input.name ?? String(current.name),
        input.aspectRatio ?? String(current.aspect_ratio),
        input.stylePreset ?? String(current.style_preset),
        input.subtitleStyle ?? String(current.subtitle_style),
        input.loudnessNormalize === undefined ? Number(current.loudness_normalize) : input.loudnessNormalize ? 1 : 0,
        input.bgmAssetId !== undefined ? input.bgmAssetId : (current.bgm_asset_id as string | null),
        input.bgmVolumeDb ?? Number(current.bgm_volume_db),
        now,
        input.projectId,
      );
    });
    return this.openProject(input.projectId);
  }

  createEpisode(projectId: string, title?: string): Episode {
    const db = this.getDb(projectId);
    const now = new Date().toISOString();
    const count = db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM episodes`)?.c ?? 0;
    const epId = `ep_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const scId = `sc_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const epTitle = title?.trim() || `第 ${Number(count) + 1} 集`;
    db.transaction(() => {
      db.run(
        `INSERT INTO episodes (id, project_id, order_index, title, script_text, source_anchors_json, updated_at)
         VALUES (?, ?, ?, ?, '', '[]', ?)`,
        epId,
        projectId,
        Number(count),
        epTitle,
        now,
      );
      db.run(`INSERT INTO scenes (id, episode_id, order_index, title, summary) VALUES (?, ?, 0, '第一场', '')`, scId, epId);
      db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, projectId);
    });
    return { id: epId, projectId, orderIndex: Number(count), title: epTitle, scriptText: "", sourceAnchors: [], updatedAt: now };
  }

  updateEpisode(rawInput: UpdateEpisodeInput): Episode {
    const input = UpdateEpisodeInputSchema.parse(rawInput);
    const db = this.getDb(input.projectId);
    const now = new Date().toISOString();
    const row = db.get<Record<string, unknown>>(`SELECT * FROM episodes WHERE id = ?`, input.episodeId);
    if (!row) throw new Error("分集不存在");
    const nextTitle = input.title ?? String(row.title);
    const nextScript = input.scriptText ?? String(row.script_text ?? "");
    const nextAnchors = input.sourceAnchors ?? JSON.parse(String(row.source_anchors_json ?? "[]"));
    db.transaction(() => {
      db.run(
        `UPDATE episodes SET title = ?, script_text = ?, source_anchors_json = ?, updated_at = ? WHERE id = ?`,
        nextTitle,
        nextScript,
        JSON.stringify(nextAnchors),
        now,
        input.episodeId,
      );
      db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
    });
    return {
      id: input.episodeId,
      projectId: input.projectId,
      orderIndex: Number(row.order_index),
      title: nextTitle,
      scriptText: nextScript,
      sourceAnchors: nextAnchors,
      updatedAt: now,
    };
  }

  createAsset(
    input: { projectId: string; kind: AssetKind; name: string; description?: string; voiceId?: string | null },
    options?: { fileTracker?: ExclusiveAssetFileTracker },
  ): Asset {
    const db = this.getDb(input.projectId);
    const dir = this.resolveProjectDir(input.projectId)!;
    const now = new Date().toISOString();
    const id = `ast_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const proj = db.get<{ aspect_ratio: string }>(`SELECT aspect_ratio FROM projects WHERE id = ?`, input.projectId);
    const ownTracker = !options?.fileTracker;
    const tracker = options?.fileTracker ?? new ExclusiveAssetFileTracker();
    const card = writeCinematicFrameSvg(dir, {
      title: input.name,
      subtitle: input.description || "待生成参考定妆图",
      tag: input.kind === "character" ? "角色设定" : input.kind === "scene" ? "场景设定" : "道具设定",
      palette: ["#151B26", "#232F44", "#3B82F6"],
      aspectRatio: proj?.aspect_ratio === "9:16" ? "9:16" : "16:9",
    }, tracker);
    try {
      db.transaction(() => {
        db.run(
          `INSERT INTO assets (id, project_id, kind, name, description, media_path, media_sha256, candidate_paths_json, locked_ref, voice_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          id, input.projectId, input.kind, input.name.trim(), input.description?.trim() ?? "",
          card.mediaPath, card.mediaSha256, JSON.stringify([card.mediaPath]), input.voiceId ?? null, now,
        );
        db.run(`UPDATE projects SET updated_at = ? WHERE id = ?`, now, input.projectId);
      });
      if (ownTracker) tracker.commit();
    } catch (err) {
      if (ownTracker) tracker.cleanupOnRollback(db);
      throw err;
    }
    return {
      id, projectId: input.projectId, kind: input.kind, name: input.name.trim(),
      description: input.description?.trim() ?? "", mediaPath: card.mediaPath,
      mediaSha256: card.mediaSha256, candidatePaths: [card.mediaPath],
      lockedRef: false, voiceId: input.voiceId ?? null, updatedAt: now,
    };
  }

  toggleAssetLock(projectId: string, assetId: string): Asset {
    const db = this.getDb(projectId);
    const now = new Date().toISOString();
    const row = db.get<Record<string, unknown>>(`SELECT * FROM assets WHERE id = ?`, assetId);
    if (!row) throw new Error("资产不存在");
    const nextLocked = Number(row.locked_ref) === 1 ? 0 : 1;
    db.run(`UPDATE assets SET locked_ref = ?, updated_at = ? WHERE id = ?`, nextLocked, now, assetId);
    const mediaPath = row.media_path ? String(row.media_path) : null;
    return {
      id: String(row.id), projectId: String(row.project_id), kind: row.kind as AssetKind,
      name: String(row.name), description: String(row.description ?? ""), mediaPath,
      mediaSha256: row.media_sha256 ? String(row.media_sha256) : null,
      candidatePaths: parseCandidatePaths(row.candidate_paths_json, mediaPath),
      lockedRef: nextLocked === 1, voiceId: row.voice_id ? String(row.voice_id) : null, updatedAt: now,
    };
  }

  createShot(input: { projectId: string; episodeId: string; sceneId: string; beforeShotId?: string | null }): Shot {
    return createShotInDb(this.getDb(input.projectId), input);
  }

  moveShot(input: { projectId: string; shotId: string; direction: "up" | "down" }): ProjectWorkspace {
    moveShotInDb(this.getDb(input.projectId), input);
    return this.openProject(input.projectId);
  }

  deleteShot(input: { projectId: string; shotId: string }): ProjectWorkspace {
    deleteShotInDb(this.getDb(input.projectId), input);
    return this.openProject(input.projectId);
  }

  updateShot(rawInput: UpdateShotInput): Shot {
    const shotId = updateShotInDb(this.getDb(rawInput.projectId), rawInput);
    const updated = this.openProject(rawInput.projectId).shots.find((s) => s.id === shotId);
    if (!updated) throw new Error("镜头保存后读取失败");
    return updated;
  }

  selectTake(input: { projectId: string; shotId: string; takeId: string; kind: TakeKind }): ProjectWorkspace {
    selectTakeInDb(this.getDb(input.projectId), input);
    return this.openProject(input.projectId);
  }

  addSyntheticTake(input: { projectId: string; shotId: string; kind: TakeKind; label?: string }): ProjectWorkspace {
    const dir = this.resolveProjectDir(input.projectId);
    if (!dir) throw new Error("作品不存在");
    addSyntheticTakeInDb(this.getDb(input.projectId), dir, input);
    return this.openProject(input.projectId);
  }

  updateAsset(rawInput: UpdateAssetInput): Asset {
    return updateAssetInDb(this.getDb(rawInput.projectId), rawInput);
  }

  importAssetImageFromPath(input: { projectId: string; assetId: string; sourceFilePath: string }): Asset {
    const dir = this.resolveProjectDir(input.projectId);
    if (!dir) throw new Error("作品不存在");
    return importAssetImageInDb(this.getDb(input.projectId), dir, input);
  }

  selectAssetCandidate(input: { projectId: string; assetId: string; mediaPath: string }): Asset {
    const dir = this.resolveProjectDir(input.projectId);
    if (!dir) throw new Error("作品不存在");
    return selectAssetCandidateInDb(this.getDb(input.projectId), dir, input);
  }

  importShotTakeFromPath(input: {
    projectId: string;
    shotId: string;
    kind: TakeKind;
    sourceFilePath: string;
    durationSec?: number | null;
    preserveExistingSelection?: boolean;
  }): ProjectWorkspace {
    const dir = this.resolveProjectDir(input.projectId);
    if (!dir) throw new Error("作品不存在");
    importShotTakeInDb(this.getDb(input.projectId), dir, input);
    return this.openProject(input.projectId);
  }

  importProjectBgmFromPath(
    projectId: string,
    sourceFilePath: string,
    meta?: { displayName?: string; description?: string },
  ): ProjectWorkspace {
    const dir = this.resolveProjectDir(projectId);
    if (!dir) throw new Error("作品不存在");
    importProjectBgmInDb(this.getDb(projectId), dir, { projectId, sourceFilePath, ...meta });
    return this.openProject(projectId);
  }
  registerProjectBgmCandidate(input: { projectId: string; name: string; mediaPath: string; mediaSha256: string; description?: string }): { assetId: string; workspace: ProjectWorkspace } {
    const assetId = registerProjectBgmCandidateInDb(this.getDb(input.projectId), input);
    return { assetId, workspace: this.openProject(input.projectId) };
  }
  applyProjectBgmCandidate(projectId: string, assetId: string): ProjectWorkspace {
    applyProjectBgmAssetInDb(this.getDb(projectId), { projectId, assetId });
    return this.openProject(projectId);
  }
  deleteProjectBgmCandidate(projectId: string, assetId: string): ProjectWorkspace {
    deleteProjectBgmCandidateInDb(this.getDb(projectId), { projectId, assetId });
    return this.openProject(projectId);
  }

  cleanUnreferencedAssets(projectId: string): { removedFiles: number; freedBytes: number } {
    const dir = this.resolveProjectDir(projectId);
    if (!dir) throw new Error("作品不存在");
    return cleanUnreferencedAssetsInProject(dir, this.getDb(projectId));
  }

  async exportArchiveToPath(projectId: string, outputZipPath: string): Promise<void> {
    const dir = this.resolveProjectDir(projectId);
    if (!dir) throw new Error("作品不存在");
    await exportProjectArchive(this.workspaceRoot, dir, this.getDb(projectId), outputZipPath);
  }

  async importArchiveFromPath(zipPath: string): Promise<ProjectWorkspace> {
    const { projectId, dirPath } = await importProjectArchive(
      this.workspaceRoot, zipPath, (id) => Boolean(this.resolveProjectDir(id)), safeFolderSegment,
    );
    this.dirByProjectId.set(projectId, dirPath);
    return this.openProject(projectId);
  }

  closeAll(): void {
    for (const db of this.openDbs.values()) db.close();
    this.openDbs.clear();
  }
}
