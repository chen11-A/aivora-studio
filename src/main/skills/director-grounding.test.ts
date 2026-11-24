import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DirectorProposal, DirectorProposedShot } from "../../shared/types/jobs";
import {
  evaluateDirectorProposalGrounding,
  extractScriptDialogueLines,
  finalizeDirectorProposal,
  mergeProposalToMaxShots,
} from "./director-grounding";
import { buildOfflineDirectorProposal } from "./director-prompt";

const FIXTURES_DIR = path.resolve(__dirname, "__fixtures__");
const FULL_WANZHAO_SCRIPT = readFileSync(path.join(FIXTURES_DIR, "wanzhao-bookstore.txt"), "utf8");
const FULL_WANZHAO_NOTES = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, "wanzhao-bookstore.notes.json"), "utf8"),
) as {
  not_dialogue: Array<{ paragraph: string; text: string; why: string }>;
  speakers: Array<{ paragraph: string; line: string; speaker: string }>;
};

function makeShot(partial: Partial<DirectorProposedShot> & { title: string }): DirectorProposedShot {
  return {
    scale: "中景",
    cameraMove: "固定",
    durationSec: 3,
    visualPrompt: partial.visualPrompt ?? partial.title,
    dialogue: "",
    speaker: "",
    subtitle: "",
    sourceExcerpt: "",
    characters: [],
    ...partial,
  };
}

describe("director-grounding (full Wanzhao Bookstore acceptance & >16-shot merge)", () => {
  it("extracts all 33 exact spoken lines from the full Wanzhao Bookstore novel while excluding shop names & sound effects", () => {
    const lines = extractScriptDialogueLines(FULL_WANZHAO_SCRIPT);
    for (const nonDlg of FULL_WANZHAO_NOTES.not_dialogue) {
      expect(lines).not.toContain(nonDlg.text);
    }
    const expected = FULL_WANZHAO_NOTES.speakers.map((s) => s.line);
    expect(lines).toEqual(expected);
    expect(lines.length).toBe(33);
  });

  it("splits the full unabridged 3-scene Wanzhao Bookstore script offline with 100% dialogue, action & ending coverage", () => {
    const proposal = buildOfflineDirectorProposal("晚照书店", FULL_WANZHAO_SCRIPT);
    expect(proposal.scenes.length).toBe(3);
    expect(proposal.scenes[0]?.title).toContain("第一场");
    expect(proposal.scenes[1]?.title).toContain("第二场");
    expect(proposal.scenes[2]?.title).toContain("第三场");

    // Full Scene 2 has 17 paragraphs in the original novel and gets merged down cleanly without dropping any line
    for (const sc of proposal.scenes) {
      expect(sc.shots.length).toBeLessThanOrEqual(16);
    }

    // Key narrative actions remain attached to their respective scenes
    const scene1Visuals = proposal.scenes[0]!.shots.map((s) => s.visualPrompt).join("\n");
    const scene2Visuals = proposal.scenes[1]!.shots.map((s) => s.visualPrompt).join("\n");
    const scene3Visuals = proposal.scenes[2]!.shots.map((s) => s.visualPrompt).join("\n");
    expect(scene1Visuals).toContain("推门进来");
    expect(scene2Visuals).toContain("把书架推倒了");
    expect(scene2Visuals).toContain("抄起一根铁棍");
    expect(scene3Visuals).toContain("捡起一本封面被踩脏的诗集");

    expect(proposal.grounding?.ok).toBe(true);
    expect(proposal.grounding?.scriptDialogueCount).toBe(33);
    expect(proposal.grounding?.matchedDialogueCount).toBe(33);
    expect(proposal.grounding?.dialogueCoveragePct).toBe(100);
    expect(proposal.grounding?.endingCovered).toBe(true);
    expect(proposal.grounding?.missingDialogues).toEqual([]);
    expect(proposal.grounding?.ungroundedDialogues).toEqual([]);
  });

  it("does NOT count sourceExcerpt as filmed dialogue when dialogue and subtitle are left empty (GPT P1 regression)", () => {
    const full = buildOfflineDirectorProposal("晚照书店", FULL_WANZHAO_SCRIPT);
    const lastSceneIdx = full.scenes.length - 1;
    const tampered: DirectorProposal = {
      ...full,
      scenes: full.scenes.map((sc, sIdx) => {
        if (sIdx !== lastSceneIdx) return sc;
        const lastShotIdx = sc.shots.length - 1;
        return {
          ...sc,
          shots: sc.shots.map((sh, i) =>
            i === lastShotIdx
              ? {
                  ...sh,
                  dialogue: "",
                  subtitle: "",
                  sourceExcerpt: "巷口卖早点的阿婆只说了一句：“灯还亮着，就好。”",
                }
              : sh,
          ),
        };
      }),
    };

    const report = evaluateDirectorProposalGrounding(tampered, FULL_WANZHAO_SCRIPT);
    expect(report.ok).toBe(false);
    expect(report.dialogueCoveragePct).toBeLessThan(100);
    expect(report.missingDialogues).toContain("灯还亮着，就好。");
    expect(report.endingCovered).toBe(false);
  });

  it("catches missing ending sentence and missing dialogue when a model truncates the tail", () => {
    const full = buildOfflineDirectorProposal("晚照书店", FULL_WANZHAO_SCRIPT);
    const truncated: DirectorProposal = {
      ...full,
      scenes: full.scenes.map((sc, idx) =>
        idx === full.scenes.length - 1 ? { ...sc, shots: sc.shots.slice(0, -1) } : sc,
      ),
    };
    const report = evaluateDirectorProposalGrounding(truncated, FULL_WANZHAO_SCRIPT);
    expect(report.ok).toBe(false);
    expect(report.endingCovered).toBe(false);
    expect(report.missingDialogues).toContain("灯还亮着，就好。");
    expect(report.warnings.some((w) => w.includes("结尾未覆盖"))).toBe(true);
  });

  it("flags ungrounded/hallucinated dialogue that does not exist in the original script", () => {
    const full = buildOfflineDirectorProposal("晚照书店", FULL_WANZHAO_SCRIPT);
    const mutated: DirectorProposal = {
      ...full,
      scenes: full.scenes.map((sc, sIdx) =>
        sIdx === 0
          ? {
              ...sc,
              shots: [
                makeShot({
                  title: "镜 00 · 编造台词",
                  dialogue: "其实我来自十年后的火星空间站。",
                  speaker: "沈砚",
                  subtitle: "其实我来自十年后的火星空间站。",
                }),
                ...sc.shots,
              ],
            }
          : sc,
      ),
    };
    const report = evaluateDirectorProposalGrounding(mutated, FULL_WANZHAO_SCRIPT);
    expect(report.ok).toBe(false);
    expect(report.ungroundedDialogues).toContain("其实我来自十年后的火星空间站。");
  });

  it("merges a >16-shot scene down to <=16 shots without dropping dialogues or truncating the ending", () => {
    const shots: DirectorProposedShot[] = [];
    for (let i = 1; i <= 19; i++) {
      const hasDialogue = i % 3 === 0;
      shots.push(
        makeShot({
          title: `镜 ${String(i).padStart(2, "0")} · 节奏 ${i}`,
          durationSec: 2,
          visualPrompt: `动作描写第${i}拍`,
          dialogue: hasDialogue ? `第${i}句关键对白。` : "",
          speaker: hasDialogue ? (i % 2 === 0 ? "林晚" : "沈砚") : "",
          subtitle: hasDialogue ? `第${i}句关键对白。` : "",
          sourceExcerpt: hasDialogue ? `第${i}句关键对白。` : `动作描写第${i}拍`,
        }),
      );
    }
    shots.push(
      makeShot({
        title: "镜 20 · 结尾收束",
        durationSec: 3,
        visualPrompt: "阿婆端来热豆浆",
        dialogue: "灯还亮着，就好。",
        speaker: "阿婆",
        subtitle: "灯还亮着，就好。",
        sourceExcerpt: "灯还亮着，就好。",
      }),
    );

    const scriptLines = shots.map((s) => (s.dialogue ? `${s.speaker}：${s.dialogue}` : s.visualPrompt));
    const proposal: DirectorProposal = {
      sourceMode: "ai",
      providerSummary: "mock",
      assets: [],
      scenes: [{ title: "第一场 · 长场景", summary: "", shots }],
    };

    const finalized = finalizeDirectorProposal(proposal, scriptLines.join("\n"));
    expect(finalized.scenes[0]!.shots.length).toBeLessThanOrEqual(16);
    expect(finalized.grounding?.mergedFromCount).toBe(20);
    expect(finalized.grounding?.endingCovered).toBe(true);
    expect(finalized.grounding?.dialogueCoveragePct).toBe(100);
    expect(finalized.grounding?.ok).toBe(true);
  });

  it("preserves all shots and warns when >16 alternating-speaker dialogue shots cannot be merged safely", () => {
    const shots: DirectorProposedShot[] = Array.from({ length: 18 }, (_, i) =>
      makeShot({
        title: `镜 ${String(i + 1).padStart(2, "0")} · 对话`,
        durationSec: 4,
        visualPrompt: `人物特写 ${i + 1}`,
        dialogue: `这是第 ${i + 1} 句不可合并的独立角色台词。`,
        speaker: i % 2 === 0 ? "林晚" : "周烈",
        subtitle: `这是第 ${i + 1} 句不可合并的独立角色台词。`,
        sourceExcerpt: `这是第 ${i + 1} 句不可合并的独立角色台词。`,
      }),
    );

    const proposal: DirectorProposal = {
      sourceMode: "ai",
      providerSummary: "mock",
      assets: [],
      scenes: [{ title: "第一场 · 激烈争执", summary: "", shots }],
    };

    const merged = mergeProposalToMaxShots(proposal, 16);
    expect(merged.proposal.scenes[0]!.shots.length).toBe(18);
    expect(merged.overflowScenes).toEqual([{ title: "第一场 · 激烈争执", shotCount: 18 }]);
    const finalized = finalizeDirectorProposal(
      proposal,
      shots.map((s) => `${s.speaker}：${s.dialogue}`).join("\n"),
    );
    expect(finalized.grounding?.endingCovered).toBe(true);
    expect(finalized.grounding?.ok).toBe(false);
    expect(finalized.grounding?.warnings.some((w) => w.includes("超过 16 镜上限"))).toBe(true);
  });
});
