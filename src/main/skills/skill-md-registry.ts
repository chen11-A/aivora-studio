import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type SkillMdStage = "screenplay" | "storyboard" | "cast" | "continuity";

export type SafeSkillDocument = {
  id: string;
  name: string;
  version: string;
  stage: SkillMdStage;
  sha256: string;
  body: string;
  rawMarkdown: string;
  isDefault: boolean;
};

const MAX_SKILL_MD_BYTES = 24 * 1024;
const VALID_STAGES = new Set<SkillMdStage>(["screenplay", "storyboard", "cast", "continuity"]);

/**
 * Patterns forbidden in plain-text SKILL.md because skills are strictly sandboxed creative templates —
 * NEVER executable scripts, network/credential exfiltrators, or F16 budget-bypass directives.
 */
const FORBIDDEN_SKILL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /<script\b/i, reason: "禁止包含可执行 HTML/JS <script> 标签" },
  { pattern: /\b(?:child_process|require\s*\(|import\s*\(|eval\s*\(|new\s+Function)\b/i, reason: "禁止包含代码执行指令" },
  { pattern: /\b(?:curl|wget|powershell|cmd\.exe|\/bin\/sh|bash\s+-c)\b/i, reason: "禁止包含终端/网络下载命令" },
  { pattern: /(?:api[_-]?key|secret_cipher|access[_-]?token|global\.db|读取密钥|外传密钥|忽略预算|绕过预算|bypass\s+budget|ignore\s+budget)/i, reason: "禁止试图读取凭据或绕过 F16 预算/安全门禁" },
];

export const DEFAULT_SKILL_DOCUMENTS: Record<string, string> = {
  "screenplay-default": [
    "---",
    "name: 默认剧本整理模板",
    "version: 2.0.0",
    "stage: screenplay",
    "---",
    "保持忠实原文，显式区分原文、推断与演绎，保留因果分场与说话人归属。",
  ].join("\n"),
  "storyboard-default": [
    "---",
    "name: 默认分镜视觉提示词模板",
    "version: 2.0.0",
    "stage: storyboard",
    "---",
    "仅描写画面内可见角色、景别、运镜、光线与动作；严禁把画外音角色或历史提及地点画入当前镜头。",
  ].join("\n"),
};

function sanitizeSkillId(raw: string): string {
  const clean = raw.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  if (!clean) throw new Error("SKILL 标识无效");
  return clean;
}

/**
 * F17: Strictly validates & parses a plain-text `SKILL.md` file:
 * - Enforces <= 24 KB size limit and UTF-8 plain text (zero null bytes).
 * - Requires YAML frontmatter with `name`, `version`, and valid `stage`.
 * - Rejects script execution, network/shell commands, credential exfiltration, and budget-bypass attempts.
 * - Binds deterministic `version` + `sha256`.
 */
export function parseAndValidateSkillMd(
  id: string,
  rawMarkdown: string,
  isDefault = false,
): SafeSkillDocument {
  const bytes = Buffer.byteLength(rawMarkdown, "utf8");
  if (bytes === 0) throw new Error("SKILL.md 内容为空");
  if (bytes > MAX_SKILL_MD_BYTES) {
    throw new Error(`SKILL.md 体积超出上限（${bytes} 字节 > ${MAX_SKILL_MD_BYTES} 字节），已拒绝导入。`);
  }
  if (rawMarkdown.includes("\u0000")) {
    throw new Error("SKILL.md 仅允许纯文本内容，拒绝二进制文件。");
  }

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(rawMarkdown.trim());
  if (!fmMatch) {
    throw new Error("SKILL.md 格式错误：顶部必须包含 `---` 包裹的 name / version / stage 元数据块。");
  }

  const metaLines = fmMatch[1]!.split(/\r?\n/);
  const meta: Record<string, string> = {};
  for (const line of metaLines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key && val) meta[key] = val;
  }

  const name = meta.name?.trim() ?? "";
  const version = meta.version?.trim() ?? "";
  const stage = meta.stage?.trim() as SkillMdStage;
  if (!name || !version || !VALID_STAGES.has(stage)) {
    throw new Error("SKILL.md 元数据不完整：需要 name、version 与有效 stage（screenplay/storyboard/cast/continuity）。");
  }

  const body = fmMatch[2]!.trim();
  if (!body) throw new Error("SKILL.md 正文提示词不能为空");

  for (const rule of FORBIDDEN_SKILL_PATTERNS) {
    if (rule.pattern.test(rawMarkdown)) {
      throw new Error(`安全拦截：${rule.reason}。SKILL.md 仅作为纯文本创作模板使用。`);
    }
  }

  const sha256 = createHash("sha256").update(rawMarkdown, "utf8").digest("hex");
  return {
    id: sanitizeSkillId(id),
    name,
    version,
    stage,
    sha256,
    body,
    rawMarkdown: rawMarkdown.trim(),
    isDefault,
  };
}

/**
 * Renders a sandboxed plain-text preview block showing explicit untrusted-data boundaries
 * so custom SKILL.md instructions can never override system safety/budget gates.
 */
export function renderSandboxedSkillPromptBlock(doc: SafeSkillDocument): string {
  return [
    `<user_creative_skill_template id="${doc.id}" version="${doc.version}" sha256="${doc.sha256.slice(0, 12)}" trust="untrusted_plain_text">`,
    doc.body,
    `</user_creative_skill_template>`,
  ].join("\n");
}

export class SkillMdRegistry {
  constructor(private readonly skillsDir: string) {
    mkdirSync(this.skillsDir, { recursive: true });
  }

  listSkills(): SafeSkillDocument[] {
    const map = new Map<string, SafeSkillDocument>();
    for (const [id, md] of Object.entries(DEFAULT_SKILL_DOCUMENTS)) {
      map.set(id, parseAndValidateSkillMd(id, md, true));
    }
    if (existsSync(this.skillsDir)) {
      for (const file of readdirSync(this.skillsDir)) {
        if (!file.endsWith(".md")) continue;
        const id = file.slice(0, -3);
        try {
          const raw = readFileSync(path.join(this.skillsDir, file), "utf8");
          map.set(id, parseAndValidateSkillMd(id, raw, false));
        } catch {
          // Ignore malformed disk files without crashing app
        }
      }
    }
    return [...map.values()];
  }

  saveSkill(id: string, rawMarkdown: string): SafeSkillDocument {
    const validated = parseAndValidateSkillMd(id, rawMarkdown, false);
    mkdirSync(this.skillsDir, { recursive: true });
    writeFileSync(path.join(this.skillsDir, `${validated.id}.md`), validated.rawMarkdown + "\n", "utf8");
    return validated;
  }

  resetSkillToDefault(id: string): SafeSkillDocument {
    const cleanId = sanitizeSkillId(id);
    const customPath = path.join(this.skillsDir, `${cleanId}.md`);
    if (existsSync(customPath)) rmSync(customPath, { force: true });
    const defMd = DEFAULT_SKILL_DOCUMENTS[cleanId];
    if (!defMd) throw new Error(`「${cleanId}」没有内置默认模板`);
    return parseAndValidateSkillMd(cleanId, defMd, true);
  }
}
