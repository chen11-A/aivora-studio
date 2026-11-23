import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectWorkspace } from "../../shared/types/domain";
import type { SqliteDriver } from "./sqlite-driver";

/**
 * Generates crisp local SVG preview frames saved under `<projectDir>/assets/`
 * so the demo project《晚照书店》renders 16:9 / 9:16 visuals offline.
 */
export function writeCinematicFrameSvg(
  projectDir: string,
  options: {
    title: string;
    subtitle: string;
    tag: string;
    palette: [string, string, string];
    aspectRatio: "16:9" | "9:16";
  },
): { mediaPath: string; mediaSha256: string } {
  const [width, height] = options.aspectRatio === "16:9" ? [1280, 720] : [720, 1280];
  const [bg1, bg2, accent] = options.palette;
  const esc = (s: string) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg1}"/>
      <stop offset="100%" stop-color="${bg2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="68%" cy="34%" r="55%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>
  <rect x="44" y="44" width="${width - 88}" height="${height - 88}" rx="12" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="1.5"/>
  <rect x="76" y="76" width="184" height="34" rx="17" fill="${accent}" fill-opacity="0.22" stroke="${accent}" stroke-opacity="0.65"/>
  <text x="168" y="99" text-anchor="middle" fill="#F3F6FB" font-family="sans-serif" font-size="16" font-weight="600">${esc(options.tag)}</text>
  <text x="76" y="${Math.round(height * 0.56)}" fill="#F8FAFC" font-family="sans-serif" font-size="${options.aspectRatio === "16:9" ? 46 : 38}" font-weight="700">${esc(options.title)}</text>
  <text x="76" y="${Math.round(height * 0.56) + 52}" fill="#CBD5E1" font-family="sans-serif" font-size="22">${esc(options.subtitle)}</text>
  <line x1="76" y1="${height - 110}" x2="${width - 76}" y2="${height - 110}" stroke="#ffffff" stroke-opacity="0.15"/>
  <text x="76" y="${height - 76}" fill="#94A3B8" font-family="monospace" font-size="16">AIVORA STUDIO · ${options.aspectRatio} · 本地预览画帧</text>
</svg>`;

  const bytes = Buffer.from(svg, "utf8");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const assetsDir = join(projectDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const fileName = `${sha.slice(0, 24)}.svg`;
  writeFileSync(join(assetsDir, fileName), bytes);
  return { mediaPath: `assets/${fileName}`, mediaSha256: sha };
}

export const DEMO_SCRIPT_EP1 = `第一场：晚照书店外 · 傍晚 · 雨后初晴
橘红色的夕阳斜斜洒在老街湿润的青石板上，屋檐滴落最后一串雨珠。「晚照书店」的木质招牌微微泛黄，橱窗里透出暖黄的台灯光。

林晚推着一辆旧自行车停在门口，摘下淋湿的帽子，抬头看了一眼橱窗里摆着的旧版诗集。

林晚（轻声）：这家店居然还开着。

第二场：晚照书店内 · 傍晚
木门推开，门楣上的铜铃发出清脆一声响。空气里弥漫着旧纸张和手冲咖啡的香气。陈伯站在高高的木书架梯子上整理古籍，闻声低头微笑。

陈伯：小晚，你终于回来了。那本夹着银杏叶的书，我替你留了整整三年。`;

export const DEMO_SCRIPT_EP2 = `第三场：书店阁楼 · 夜
窗外街灯渐亮，阁楼木桌上摊开着泛黄的手写笔记。林晚小心翻开夹着干枯银杏叶的那一页，纸页间滑出一张老式火车票。

林晚：原来当年父亲根本没有离开这座城……`;

export function populateDemoProject(db: SqliteDriver, created: ProjectWorkspace): void {
  const projectId = created.project.id;
  const dir = created.dirPath;
  const now = new Date().toISOString();
  const ep1 = created.episodes[0]!;
  const sc1 = created.scenes[0]!;
  const firstShot = created.shots[0]!;

  const ep2Id = `ep_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const sc2Id = `sc_${randomUUID().replaceAll("-", "").slice(0, 10)}`;

  const char1Img = writeCinematicFrameSvg(dir, {
    title: "林晚 · 角色定妆",
    subtitle: "浅灰风衣 · 微湿碎发 · 柔和逆光",
    tag: "角色参考已锁定",
    palette: ["#1E293B", "#334155", "#60A5FA"],
    aspectRatio: "16:9",
  });
  const char2Img = writeCinematicFrameSvg(dir, {
    title: "陈伯 · 角色定妆",
    subtitle: "旧针织衫 · 圆框老花镜 · 温暖微笑",
    tag: "角色参考已锁定",
    palette: ["#27201A", "#3F2E21", "#F59E0B"],
    aspectRatio: "16:9",
  });
  const sceneImg = writeCinematicFrameSvg(dir, {
    title: "晚照书店 · 橱窗夕阳",
    subtitle: "雨后青石板 · 暖黄台灯 · 老街暮色",
    tag: "核心场景",
    palette: ["#1F1A17", "#432818", "#F97316"],
    aspectRatio: "16:9",
  });
  const shot1v2 = writeCinematicFrameSvg(dir, {
    title: "镜 01 · 晚照书店远景（版本 2）",
    subtitle: "雨珠自屋檐滴落 · 暖光穿透玻璃橱窗",
    tag: "版本 2 · 使用中",
    palette: ["#1B1917", "#451A03", "#F59E0B"],
    aspectRatio: "16:9",
  });
  const shot2v1 = writeCinematicFrameSvg(dir, {
    title: "镜 02 · 林晚驻足橱窗",
    subtitle: "中近景缓推 · 橱窗倒映夕阳余晖",
    tag: "版本 1 · 使用中",
    palette: ["#0F172A", "#1E3A5F", "#38BDF8"],
    aspectRatio: "16:9",
  });
  const shot3v1 = writeCinematicFrameSvg(dir, {
    title: "镜 03 · 推门铜铃轻响",
    subtitle: "室内暖光与书架纵深 · 陈伯回头微笑",
    tag: "版本 1 · 使用中",
    palette: ["#231B15", "#4A321F", "#10B981"],
    aspectRatio: "16:9",
  });

  db.transaction(() => {
    db.run(
      `UPDATE projects SET cover_asset_path = ?, updated_at = ? WHERE id = ?`,
      sceneImg.mediaPath,
      now,
      projectId,
    );
    db.run(
      `INSERT INTO episodes (id, project_id, order_index, title, script_text, source_anchors_json, updated_at)
       VALUES (?, ?, 1, '第 2 集 · 阁楼旧票', ?, '[]', ?)`,
      ep2Id,
      projectId,
      DEMO_SCRIPT_EP2,
      now,
    );
    db.run(
      `INSERT INTO assets (id, project_id, kind, name, description, media_path, media_sha256, locked_ref, voice_id, updated_at)
       VALUES
         ('ast_linwan', ?, 'character', '林晚', '24岁插画师，浅灰风衣，眼神沉静温柔', ?, ?, 1, 'zh_female_warm', ?),
         ('ast_chenbo', ?, 'character', '陈伯', '68岁旧书店店主，圆框眼镜，语调舒缓', ?, ?, 1, 'zh_male_elder', ?),
         ('ast_shop', ?, 'scene', '晚照书店', '老街拐角木结构书店，黄昏暖光与雨后反光石板', ?, ?, 1, NULL, ?)`,
      projectId,
      char1Img.mediaPath,
      char1Img.mediaSha256,
      now,
      projectId,
      char2Img.mediaPath,
      char2Img.mediaSha256,
      now,
      projectId,
      sceneImg.mediaPath,
      sceneImg.mediaSha256,
      now,
    );
    db.run(
      `UPDATE scenes SET title = '第一场 · 晚照书店外', summary = '雨后傍晚，林晚重返老街书店门口' WHERE id = ?`,
      sc1.id,
    );
    db.run(
      `INSERT INTO scenes (id, episode_id, order_index, title, location_asset_id, summary)
       VALUES (?, ?, 1, '第二场 · 书店内铜铃重逢', 'ast_shop', '推门而入，陈伯递出保存三年的诗集')`,
      sc2Id,
      ep1.id,
    );

    const take1v2Id = `tk_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    db.run(`UPDATE takes SET is_selected = 0 WHERE shot_id = ?`, firstShot.id);
    db.run(
      `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, created_at)
       VALUES (?, ?, 'image', 2, ?, ?, '雨后老街晚照书店外景，橘红晚霞映湿润青石板', '示例画帧 v2', 1, ?)`,
      take1v2Id,
      firstShot.id,
      shot1v2.mediaPath,
      shot1v2.mediaSha256,
      now,
    );
    db.run(
      `UPDATE shots SET title = '镜 01 · 雨后书店外景', scale = '远景', camera_move = '缓推', duration_sec = 4,
       visual_prompt = '雨后傍晚的老街，橘红夕阳洒在青石板上，晚照书店木招牌与暖黄橱窗灯光，电影感 35mm',
       dialogue = '', speaker = '', subtitle = '雨后初晴的老街，晚照书店亮起了灯。',
       selected_image_take_id = ?, updated_at = ? WHERE id = ?`,
      take1v2Id,
      now,
      firstShot.id,
    );

    const sh2Id = `sh_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const tk2Id = `tk_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    db.run(
      `INSERT INTO shots (id, scene_id, episode_id, order_index, title, scale, camera_move, duration_sec, visual_prompt, dialogue, speaker, subtitle, selected_image_take_id, updated_at)
       VALUES (?, ?, ?, 1, '镜 02 · 林晚驻足橱窗', '近景', '缓推', 3, '林晚停下旧自行车摘下湿帽，侧脸望向橱窗里的诗集，玻璃倒映夕阳余晖', '这家店居然还开着。', '林晚', '这家店居然还开着。', ?, ?)`,
      sh2Id,
      sc1.id,
      ep1.id,
      tk2Id,
      now,
    );
    db.run(
      `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, created_at)
       VALUES (?, ?, 'image', 1, ?, ?, '林晚驻足书店橱窗', '示例画帧 v1', 1, ?)`,
      tk2Id,
      sh2Id,
      shot2v1.mediaPath,
      shot2v1.mediaSha256,
      now,
    );

    const sh3Id = `sh_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const tk3Id = `tk_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    db.run(
      `INSERT INTO shots (id, scene_id, episode_id, order_index, title, scale, camera_move, duration_sec, visual_prompt, dialogue, speaker, subtitle, selected_image_take_id, updated_at)
       VALUES (?, ?, ?, 2, '镜 03 · 推门铜铃轻响', '中景', '横摇', 5, '书店木门推开铜铃晃动，高大书架间光线穿过微尘，陈伯站在木梯上微笑回头', '小晚，你终于回来了。那本夹着银杏叶的书，我替你留了整整三年。', '陈伯', '那本夹着银杏叶的书，我替你留了整整三年。', ?, ?)`,
      sh3Id,
      sc2Id,
      ep1.id,
      tk3Id,
      now,
    );
    db.run(
      `INSERT INTO takes (id, shot_id, kind, version_number, media_path, media_sha256, prompt_snapshot, provider_info, is_selected, created_at)
       VALUES (?, ?, 'image', 1, ?, ?, '书店内推门重逢', '示例画帧 v1', 1, ?)`,
      tk3Id,
      sh3Id,
      shot3v1.mediaPath,
      shot3v1.mediaSha256,
      now,
    );
  });
}
