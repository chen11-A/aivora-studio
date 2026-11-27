import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DirectorProposal } from "../../shared/types/jobs";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { buildOfflineDirectorProposal, sanitizeDirectorProposal } from "./director-prompt";
import { DirectorService } from "./director-service";
import {
  isCharacterExplicitlyOffscreen,
  isSpeakerOffscreen,
  resolveOnScreenCharacters,
} from "./onscreen-characters";

const tempDirs: string[] = [];

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (buf) => buf.toString("utf8"),
});

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Off-screen character exclusion (Bug 3 regression)", () => {
  it("excludes explicitly off-screen, voice-over, and mentioned-only characters while preserving on-screen presence", () => {
    const cast = ["林晚", "沈砚", "周烈"];

    // 1. Bookstore Shot 2: off-screen voice / explicitly not in frame
    const shot2A = "门外传来沈砚的声音（沈砚不入画）：“先别关灯。”林晚停下手中动作，抬头望向玻璃门。";
    expect(isCharacterExplicitlyOffscreen(shot2A, "沈砚")).toBe(true);
    expect(isSpeakerOffscreen(shot2A, "沈砚")).toBe(true);
    expect(
      resolveOnScreenCharacters({ text: shot2A, canonicalCharacterNames: cast, speaker: "沈砚" }),
    ).toEqual(["林晚"]);

    // 2. Explicit negation before or after name without voice-over
    const shot2B = "林晚独自在书店柜台后翻看账本，明确不入画的沈砚还在巷口雨里。";
    expect(resolveOnScreenCharacters({ text: shot2B, canonicalCharacterNames: cast })).toEqual(["林晚"]);

    const shot2C = "林晚整理旧书，沈砚没有入画。";
    expect(resolveOnScreenCharacters({ text: shot2C, canonicalCharacterNames: cast })).toEqual(["林晚"]);

    const shot2CrossComma = "林晚抬头看门，沈砚站在门外，并不入画。";
    expect(resolveOnScreenCharacters({ text: shot2CrossComma, canonicalCharacterNames: cast })).toEqual(["林晚"]);

    const shot2VoiceOnly = "林晚停下脚步，沈砚在店外，只闻其声。";
    expect(resolveOnScreenCharacters({ text: shot2VoiceOnly, canonicalCharacterNames: cast })).toEqual(["林晚"]);

    // 3. Parenthetical stage direction: 沈砚（画外音）：...
    const shot2D = "沈砚（画外音）：别动那本诗集。";
    expect(
      resolveOnScreenCharacters({ text: shot2D, canonicalCharacterNames: cast, speaker: "沈砚" }),
    ).toEqual([]);

    // 4. Mentioned only inside another character's spoken dialogue or memory
    const shot2E = "林晚轻声说：“沈砚怎么还没来？”";
    expect(
      resolveOnScreenCharacters({ text: shot2E, canonicalCharacterNames: cast, speaker: "林晚" }),
    ).toEqual(["林晚"]);

    const shot2F = "林晚盯着收银台上的油纸信封，想起沈砚留下的那句话。";
    expect(resolveOnScreenCharacters({ text: shot2F, canonicalCharacterNames: cast })).toEqual(["林晚"]);

    // 5. Exclusive framing statement
    const shot2G = "镜头里只有林晚，门外响起沈砚急促的脚步声。";
    expect(resolveOnScreenCharacters({ text: shot2G, canonicalCharacterNames: cast })).toEqual(["林晚"]);

    // 6. On-screen entrance & self-introduction MUST still include 沈砚!
    const shot3OnScreen = "沈砚推门走进书店，收起雨伞：“我找林国栋。”";
    expect(
      resolveOnScreenCharacters({ text: shot3OnScreen, canonicalCharacterNames: cast, speaker: "沈砚" }),
    ).toEqual(["沈砚"]);

    const selfIntro = "男人把信封放在收银台上：“我叫沈砚。”";
    expect(resolveOnScreenCharacters({ text: selfIntro, canonicalCharacterNames: cast })).toEqual(["沈砚"]);
  });

  it("excludes off-screen 沈砚 from bookstore Shot 2 in new project offline split, applyProposal, and AI sanitizer", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-offscreen-bookstore-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const director = new DirectorService(projects, globalConfig, oauth);

    const bookstoreScript = [
      "第一场：晚照书店 · 雨夜",
      "雨夜的晚照书店亮着暖黄台灯，林晚轻声说：“今晚把这箱收完就打烊。”",
      "林晚抬头看向玻璃门，门外传来沈砚的声音，沈砚不入画：“林小姐，先别关门。”",
      "沈砚推开玻璃门走进书店，抖落黑色风衣上的雨水：“我找林国栋。”",
    ].join("\n\n");

    const created = projects.createProject({ name: "晚照书店画外角色回归", aspectRatio: "16:9" });
    const epId = created.episodes[0]!.id;
    projects.updateEpisode({
      projectId: created.project.id,
      episodeId: epId,
      scriptText: bookstoreScript,
    });

    const splitRes = await director.proposeSplit({ projectId: created.project.id, episodeId: epId });
    expect(splitRes.ok).toBe(true);
    const proposal = splitRes.proposal!;
    const proposedShots = proposal.scenes.flatMap((s) => s.shots);
    expect(proposedShots.length).toBe(3);

    // Shot 2: speaker is still 沈砚 (for TTS voice), but visible characters MUST ONLY be 林晚 (NOT 沈砚!)
    const proposedShot2 = proposedShots[1]!;
    expect(proposedShot2.speaker).toBe("沈砚");
    expect(proposedShot2.characters).toContain("林晚");
    expect(proposedShot2.characters).not.toContain("沈砚");

    // Shot 3: 沈砚 walks into frame -> MUST include 沈砚
    const proposedShot3 = proposedShots[2]!;
    expect(proposedShot3.characters).toContain("沈砚");

    // Apply proposal into real SQLite workspace and verify persisted characterAssetIds on Shot 2 vs Shot 3
    const applied = director.applyProposal({ projectId: created.project.id, episodeId: epId, proposal });
    expect(applied.ok).toBe(true);
    const ws = projects.openProject(created.project.id);
    const linwan = ws.assets.find((a) => a.kind === "character" && a.name === "林晚");
    const shenyan = ws.assets.find((a) => a.kind === "character" && a.name === "沈砚");
    expect(linwan).toBeDefined();
    expect(shenyan).toBeDefined();

    const dbShots = ws.shots.filter((s) => s.episodeId === epId).sort((a, b) => a.orderIndex - b.orderIndex);
    expect(dbShots[1]!.characterAssetIds).toContain(linwan!.id);
    expect(dbShots[1]!.characterAssetIds).not.toContain(shenyan!.id);
    expect(dbShots[2]!.characterAssetIds).toContain(shenyan!.id);

    // AI sanitizer must also strip off-screen 沈砚 even if an LLM erroneously included him in shot.characters
    const dirtyAiProposal: DirectorProposal = {
      ...buildOfflineDirectorProposal("第 1 集", bookstoreScript),
      sourceMode: "ai",
      scenes: proposal.scenes.map((sc) => ({
        ...sc,
        shots: sc.shots.map((sh, idx) =>
          idx === 1 ? { ...sh, characters: ["林晚", "沈砚"], speaker: "沈砚" } : sh,
        ),
      })),
    };
    const sanitized = sanitizeDirectorProposal(dirtyAiProposal, bookstoreScript, ws.assets);
    const sanitizedShot2 = sanitized.scenes.flatMap((s) => s.shots)[1]!;
    expect(sanitizedShot2.speaker).toBe("沈砚");
    expect(sanitizedShot2.characters).toEqual(["林晚"]);

    projects.closeAll();
    globalConfig.close();
  });
});
