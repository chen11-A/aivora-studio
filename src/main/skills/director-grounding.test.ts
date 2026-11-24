import { describe, expect, it } from "vitest";
import type { DirectorProposal, DirectorProposedShot } from "../../shared/types/jobs";
import {
  evaluateDirectorProposalGrounding,
  extractScriptDialogueLines,
  finalizeDirectorProposal,
  mergeProposalToMaxShots,
} from "./director-grounding";
import { buildOfflineDirectorProposal } from "./director-prompt";

const WANZHAO_SCRIPT = `第一场\u3000雨夜旧书店

入秋后的第一场大雨来得又急又猛。巷子尽头那家“晚照书店”还亮着灯，玻璃门上贴着一张褪色的纸条：本店月底停业。

门铃“叮”地响了一声。

“打烊了。”林晚头也没抬，“要买书的话，明天来吧，全场五折。”

“我不买书。”男人的声音很低，“我找林国栋。”

“他三年前就不在了。”她说，“你是谁？”

男人沉默了几秒，从风衣内袋里掏出一个用油纸包着的信封，放在收银台上。“我叫沈砚。十年前，你父亲借给我母亲一笔钱，救了她一命。她临走前让我一定把钱还上。”

林晚低下头，声音有些发紧：“你来晚了。这家店，下个月就没了。”

第二场\u3000码头仓库

“我爸没欠过你们钱！”林晚攥紧了衣角，“那张借条是假的，我已经报警了。”

沈砚扣住周烈的手腕，一拧，铁棍“当啷”落地。

“小心！”林晚尖叫。

“算你狠。”周烈啐了一口，带着人钻进雨里，消失在仓库后门。

第三场\u3000医院走廊

“你本来可以不管的。”她的声音很轻，“这是我家的事。”

“因为那张照片里，你爸笑得很开心。”他顿了顿，“我想让那扇门一直亮着灯。”

天亮的时候，两人一起回到青石巷。林晚蹲下去，捡起一本封面被踩脏的诗集，用袖子一点点擦干净。沈砚把倒下的书架扶起来，一层一层地摆正。巷口卖早点的阿婆探头看了一眼，端来两碗热豆浆，什么也没问，只说了一句：“灯还亮着，就好。”`;

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

describe("director-grounding (Wanzhao Bookstore acceptance & >16-shot merge)", () => {
  it("extracts spoken dialogues from Wanzhao Bookstore while ignoring shop names and onomatopoeia", () => {
    const lines = extractScriptDialogueLines(WANZHAO_SCRIPT);
    expect(lines).not.toContain("晚照书店");
    expect(lines).not.toContain("叮");
    expect(lines).not.toContain("当啷");
    expect(lines).toContain("打烊了。");
    expect(lines).toContain("要买书的话，明天来吧，全场五折。");
    expect(lines).toContain("灯还亮着，就好。");
    expect(lines.length).toBe(17);
  });

  it("splits the full 3-scene Wanzhao Bookstore script offline with 100% dialogue & ending coverage", () => {
    const proposal = buildOfflineDirectorProposal("晚照书店", WANZHAO_SCRIPT);
    expect(proposal.scenes.length).toBe(3);
    expect(proposal.scenes[0]?.title).toContain("第一场");
    expect(proposal.scenes[2]?.title).toContain("第三场");
    expect(proposal.grounding?.ok).toBe(true);
    expect(proposal.grounding?.dialogueCoveragePct).toBe(100);
    expect(proposal.grounding?.endingCovered).toBe(true);
    expect(proposal.grounding?.missingDialogues).toEqual([]);
    expect(proposal.grounding?.ungroundedDialogues).toEqual([]);
  });

  it("catches missing ending sentence and missing dialogue when a model truncates the tail", () => {
    const full = buildOfflineDirectorProposal("晚照书店", WANZHAO_SCRIPT);
    const truncated: DirectorProposal = {
      ...full,
      scenes: full.scenes.map((sc, idx) =>
        idx === full.scenes.length - 1 ? { ...sc, shots: sc.shots.slice(0, -1) } : sc,
      ),
    };
    const report = evaluateDirectorProposalGrounding(truncated, WANZHAO_SCRIPT);
    expect(report.ok).toBe(false);
    expect(report.endingCovered).toBe(false);
    expect(report.missingDialogues).toContain("灯还亮着，就好。");
    expect(report.warnings.some((w) => w.includes("结尾未覆盖"))).toBe(true);
  });

  it("flags ungrounded/hallucinated dialogue that does not exist in the original script", () => {
    const full = buildOfflineDirectorProposal("晚照书店", WANZHAO_SCRIPT);
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
    const report = evaluateDirectorProposalGrounding(mutated, WANZHAO_SCRIPT);
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
