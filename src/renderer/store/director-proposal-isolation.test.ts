import { afterEach, describe, expect, it } from "vitest";
import type { AivoraDesktopApi } from "@shared/ipc-contract";
import {
  EpisodeSchema,
  ProjectSchema,
  SceneSchema,
  ShotSchema,
  type ProjectWorkspace,
} from "@shared/types/domain";
import type { DirectorProposal } from "@shared/types/jobs";
import {
  createStoryPipelineActions,
  type StoryPipelineActions,
  type StoryPipelineStateSlice,
} from "./story-pipeline-actions";
import { useStudioStore } from "./useStudioStore";

const NOW = "2026-11-25T00:00:00.000Z";

function makeWorkspace(projectId: string, name: string): ProjectWorkspace {
  return {
    dirPath: `/tmp/${projectId}`,
    project: ProjectSchema.parse({
      id: projectId,
      name,
      createdAt: NOW,
      updatedAt: NOW,
    }),
    episodes: [
      EpisodeSchema.parse({
        id: `${projectId}_epA`,
        projectId,
        orderIndex: 0,
        title: "第 1 集：雨夜来客",
        scriptText: "第一场 书店\n林晚抬头看门外。",
        updatedAt: NOW,
      }),
      EpisodeSchema.parse({
        id: `${projectId}_epB`,
        projectId,
        orderIndex: 1,
        title: "第 2 集：风雪栈道",
        scriptText: "第一场 栈道\n沈青立于断桥之上。",
        updatedAt: NOW,
      }),
    ],
    scenes: [
      SceneSchema.parse({
        id: `${projectId}_scA`,
        episodeId: `${projectId}_epA`,
        orderIndex: 0,
        title: "第一场 书店",
        summary: "书店雨夜",
      }),
      SceneSchema.parse({
        id: `${projectId}_scB`,
        episodeId: `${projectId}_epB`,
        orderIndex: 0,
        title: "第一场 栈道",
        summary: "风雪栈道",
      }),
    ],
    assets: [],
    shots: [
      ShotSchema.parse({
        id: `${projectId}_shA1`,
        episodeId: `${projectId}_epA`,
        sceneId: `${projectId}_scA`,
        orderIndex: 0,
        title: "A1 原镜",
        visualPrompt: "A 集原始镜头",
        updatedAt: NOW,
      }),
      ShotSchema.parse({
        id: `${projectId}_shB1`,
        episodeId: `${projectId}_epB`,
        sceneId: `${projectId}_scB`,
        orderIndex: 0,
        title: "B1 原镜",
        visualPrompt: "B 集原始镜头（绝不该被覆盖）",
        updatedAt: NOW,
      }),
    ],
    takes: [],
    jobs: [],
  };
}

function makeProposal(projectId: string, episodeId: string, episodeTitle: string, prompt: string): DirectorProposal {
  return {
    targetProjectId: projectId,
    targetEpisodeId: episodeId,
    targetEpisodeTitle: episodeTitle,
    sourceMode: "ai",
    providerSummary: "MockAI",
    assets: [],
    scenes: [
      {
        title: "第一场",
        summary: "提案场",
        shots: [
          {
            title: "新拆镜 1",
            scale: "近景",
            cameraMove: "缓推",
            durationSec: 4,
            visualPrompt: prompt,
            dialogue: "",
            speaker: "",
            subtitle: "",
            sourceExcerpt: "",
            characters: [],
          },
        ],
      },
    ],
  };
}

function createHarness(client: Partial<AivoraDesktopApi>) {
  let state: StoryPipelineStateSlice = {
    directorLoading: false,
    directorProposal: null,
    directorProposalTarget: null,
    softTargetShotsPerScene: 16,
    screenwriterOpen: false,
    screenwriterProjectId: null,
    screenwriterOutline: null,
    liveReviewReport: null,
    actionPolishLoadingShotId: null,
    actionPolishProposal: null,
    lastUndoToken: null,
  };
  const set = (partial: Partial<StoryPipelineStateSlice>) => {
    state = { ...state, ...partial };
  };
  const actions: StoryPipelineActions = createStoryPipelineActions(
    client as AivoraDesktopApi,
    set,
    () => ({ ...state, ...actions }),
  );
  return { getState: () => state, actions };
}

afterEach(() => {
  useStudioStore.setState({
    workspace: null,
    activeEpisodeId: null,
    activeShotId: null,
    toast: null,
  });
});

describe("Renderer story-pipeline director proposal isolation (GPT P1 regression)", () => {
  it("writes Episode A's proposal strictly to Episode A (never B) even if user switched A -> B while generating", async () => {
    const ws = makeWorkspace("prj_1", "作品一");
    const epA = ws.episodes[0]!;
    const epB = ws.episodes[1]!;

    useStudioStore.setState({
      workspace: ws,
      activeEpisodeId: epA.id,
      activeShotId: ws.shots[0]!.id,
    });

    let resolveProposeA!: (val: { ok: boolean; proposal?: DirectorProposal; message: string }) => void;
    const applyCalls: Array<{ projectId: string; episodeId: string }> = [];

    const harness = createHarness({
      proposeDirectorSplit: () =>
        new Promise((resolve) => {
          resolveProposeA = resolve;
        }),
      applyDirectorProposal: async (input) => {
        applyCalls.push({ projectId: input.projectId, episodeId: input.episodeId });
        const nextWs = structuredClone(ws);
        nextWs.shots = nextWs.shots.map((s) =>
          s.episodeId === input.episodeId
            ? { ...s, visualPrompt: input.proposal.scenes[0]!.shots[0]!.visualPrompt }
            : s,
        );
        return { ok: true, workspace: nextWs, undoToken: "undo_a", message: "已写入 A 集" };
      },
      reviewEpisodeShots: async () => ({ ok: false, message: "skip" }),
    });

    const pendingA = harness.actions.proposeDirector();

    // User switches from A to B IMMEDIATELY (even before flushEdits finishes!)
    useStudioStore.setState({ activeEpisodeId: epB.id, activeShotId: ws.shots[1]!.id });
    await new Promise((r) => setTimeout(r, 0));

    resolveProposeA({
      ok: true,
      proposal: makeProposal(ws.project.id, epA.id, epA.title, "A 集新拆镜画面"),
      message: "提案就绪",
    });
    await pendingA;

    expect(harness.getState().directorProposalTarget).toEqual({
      projectId: ws.project.id,
      episodeId: epA.id,
      episodeTitle: epA.title,
    });
    expect(useStudioStore.getState().toast).toContain("切回该分集即可查看与采纳");

    // User clicks Apply while activeEpisodeId is STILL B
    const applied = await harness.actions.applyDirector();
    expect(applied).toBe(true);
    expect(applyCalls).toEqual([{ projectId: ws.project.id, episodeId: epA.id }]);

    // Workspace automatically focuses back on Episode A, while Episode B remains untouched
    const cur = useStudioStore.getState();
    expect(cur.activeEpisodeId).toBe(epA.id);
    expect(cur.workspace?.shots.find((s) => s.episodeId === epA.id)?.visualPrompt).toBe("A 集新拆镜画面");
    expect(cur.workspace?.shots.find((s) => s.episodeId === epB.id)?.visualPrompt).toBe(
      "B 集原始镜头（绝不该被覆盖）",
    );
  });

  it("drops stale proposals when switching projects mid-generation and ignores superseded out-of-order responses", async () => {
    const ws1 = makeWorkspace("prj_1", "作品一");
    const ws2 = makeWorkspace("prj_2", "作品二");

    useStudioStore.setState({ workspace: ws1, activeEpisodeId: ws1.episodes[0]!.id });

    const resolvers: Array<(val: { ok: boolean; proposal?: DirectorProposal; message: string }) => void> = [];
    const harness = createHarness({
      proposeDirectorSplit: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    });

    // 1. Overlapping requests within Project 1 (A then B): slow A response must NOT overwrite newer B response
    const reqA = harness.actions.proposeDirector();
    await new Promise((r) => setTimeout(r, 0));
    useStudioStore.setState({ activeEpisodeId: ws1.episodes[1]!.id });
    const reqB = harness.actions.proposeDirector();
    await new Promise((r) => setTimeout(r, 0));

    resolvers[1]!({
      ok: true,
      proposal: makeProposal(ws1.project.id, ws1.episodes[1]!.id, ws1.episodes[1]!.title, "B 新提案"),
      message: "B 就绪",
    });
    await reqB;
    expect(harness.getState().directorProposalTarget?.episodeId).toBe(ws1.episodes[1]!.id);

    // Late A response arrives after B — MUST be ignored
    resolvers[0]!({
      ok: true,
      proposal: makeProposal(ws1.project.id, ws1.episodes[0]!.id, ws1.episodes[0]!.title, "A 过期提案"),
      message: "A 就绪",
    });
    await reqA;
    expect(harness.getState().directorProposalTarget?.episodeId).toBe(ws1.episodes[1]!.id);

    // 2. Switching from Project 1 to Project 2 mid-generation drops Project 1's response
    harness.actions.closeDirectorProposal();
    const reqProj1 = harness.actions.proposeDirector();
    await new Promise((r) => setTimeout(r, 0));
    useStudioStore.setState({ workspace: ws2, activeEpisodeId: ws2.episodes[0]!.id });

    resolvers[2]!({
      ok: true,
      proposal: makeProposal(ws1.project.id, ws1.episodes[1]!.id, ws1.episodes[1]!.title, "作品一旧提案"),
      message: "作品一就绪",
    });
    await reqProj1;

    expect(harness.getState().directorProposal).toBeNull();
    expect(harness.getState().directorProposalTarget).toBeNull();
  });

  it("blocks sending script to director when local persistence flush fails", async () => {
    const ws = makeWorkspace("prj_savefail", "保存失败拦截测试");
    useStudioStore.setState({
      workspace: ws,
      activeEpisodeId: ws.episodes[0]!.id,
      saveState: "saved",
    });

    // Inject a failing persistence operation via editEpisodeScript on a non-existent preview project
    useStudioStore.getState().editEpisodeScript(ws.episodes[0]!.id, "尚未成功落盘的新剧本");

    let directorCalls = 0;
    const harness = createHarness({
      proposeDirectorSplit: async () => {
        directorCalls += 1;
        return { ok: true, message: "should not be called" };
      },
    });

    await harness.actions.proposeDirector();
    expect(directorCalls).toBe(0);
    expect(useStudioStore.getState().saveState).toBe("error");
    expect(useStudioStore.getState().toast).toContain("本地保存失败");
  });
});
