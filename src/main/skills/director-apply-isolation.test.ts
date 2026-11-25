import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OAuthManager } from "../auth/auth-manager";
import { createSecretVault } from "../auth/secret-vault";
import { GlobalConfigStore } from "../storage/global-store";
import { ProjectStore } from "../storage/project-store";
import { DirectorService } from "./director-service";

const tempDirs: string[] = [];
const openProjectStores: ProjectStore[] = [];
const openGlobalStores: GlobalConfigStore[] = [];

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (buf) => buf.toString("utf8"),
});

afterEach(() => {
  while (openProjectStores.length > 0) {
    try {
      openProjectStores.pop()!.closeAll();
    } catch {
      // ignore double-close
    }
  }
  while (openGlobalStores.length > 0) {
    try {
      openGlobalStores.pop()!.close();
    } catch {
      // ignore double-close
    }
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("DirectorService server-side episode & project provenance guard (GPT P1 regression)", () => {
  it("stamps origin project/episode on proposals and rejects cross-episode and cross-project apply", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "aivora-episo-"));
    tempDirs.push(base);
    const projects = new ProjectStore(path.join(base, "ws"));
    const globalConfig = new GlobalConfigStore(path.join(base, "app"), mockVault);
    openProjectStores.push(projects);
    openGlobalStores.push(globalConfig);
    const oauth = new OAuthManager(globalConfig, async () => undefined);
    const director = new DirectorService(projects, globalConfig, oauth);

    const ws = projects.openDemoProject();
    const proj2 = projects.createProject({ name: "作品二", aspectRatio: "9:16" });
    const epA = ws.episodes[0]!;
    const epB = projects.createEpisode(ws.project.id, "第 2 集：风雪栈道");
    projects.updateEpisode({
      projectId: ws.project.id,
      episodeId: epB.id,
      scriptText: "第一场 栈道\n风雪交加，沈青跃上断桥。\n沈青：「别回头！」",
    });

    const proposedA = await director.proposeSplit({ projectId: ws.project.id, episodeId: epA.id });
    expect(proposedA.ok).toBe(true);
    expect(proposedA.proposal?.targetProjectId).toBe(ws.project.id);
    expect(proposedA.proposal?.targetEpisodeId).toBe(epA.id);
    expect(proposedA.proposal?.targetEpisodeTitle).toBe(epA.title);

    // 1. Cross-episode apply MUST be rejected with zero shots written to Episode B
    const crossEpisodeApply = director.applyProposal({
      projectId: ws.project.id,
      episodeId: epB.id,
      proposal: proposedA.proposal!,
    });
    expect(crossEpisodeApply.ok).toBe(false);
    expect(crossEpisodeApply.message).toContain("防分镜串集");
    expect(projects.openProject(ws.project.id).shots.filter((s) => s.episodeId === epB.id)).toHaveLength(0);

    // 2. Cross-project apply MUST be rejected with Project 2 shots completely unchanged
    const proj2InitialShotIds = proj2.shots.map((s) => s.id);
    const crossProjectApply = director.applyProposal({
      projectId: proj2.project.id,
      episodeId: proj2.episodes[0]!.id,
      proposal: proposedA.proposal!,
    });
    expect(crossProjectApply.ok).toBe(false);
    expect(crossProjectApply.message).toContain("跨作品覆盖");
    expect(projects.openProject(proj2.project.id).shots.map((s) => s.id)).toEqual(proj2InitialShotIds);

    // 3. Matching origin project & episode succeeds cleanly
    const validApply = director.applyProposal({
      projectId: ws.project.id,
      episodeId: epA.id,
      proposal: proposedA.proposal!,
    });
    expect(validApply.ok).toBe(true);
    expect(projects.openProject(ws.project.id).shots.filter((s) => s.episodeId === epB.id)).toHaveLength(0);
  });
});
