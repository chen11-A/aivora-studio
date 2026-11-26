import { useEffect } from "react";
import { evaluateEpisodeExportReadiness } from "@shared/media-selection";
import { BatchJobModal } from "./components/BatchJobModal";
import { ConfirmJobModal } from "./components/ConfirmJobModal";
import { JobDrawer } from "./components/JobDrawer";
import { StudioShell } from "./components/StudioShell";
import { StageContainer } from "./components/ui/StageContainer";
import { CastStage } from "./features/cast/CastStage";
import { DeliveryStage } from "./features/delivery/DeliveryStage";
import { EditorStage } from "./features/editor/EditorStage";
import { ExportModal } from "./features/editor/ExportModal";
import { ProjectHome } from "./features/home/ProjectHome";
import { ModelCenterModal } from "./features/models/ModelCenterModal";
import { ScriptStage } from "./features/script/ScriptStage";
import { StoryboardStage } from "./features/storyboard/StoryboardStage";
import { getDesktopClient } from "./lib/desktop-client";
import { flushPendingSaves, useStudioStore } from "./store/useStudioStore";

export function App() {
  const workspace = useStudioStore((s) => s.workspace);
  const activeStage = useStudioStore((s) => s.activeStage);
  const activeEpisodeId = useStudioStore((s) => s.activeEpisodeId);
  const bootstrap = useStudioStore((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const client = getDesktopClient();
    return client.onFlushBeforeClose(() => {
      void flushPendingSaves()
        .then((ok) => client.notifyFlushComplete(ok))
        .catch(() => client.notifyFlushComplete(false));
    });
  }, []);

  const viewKey = workspace ? activeStage : "home";
  const readiness = workspace ? evaluateEpisodeExportReadiness(workspace, activeEpisodeId) : null;

  return (
    <>
      <StudioShell>
        <StageContainer viewKey={viewKey}>
          {!workspace ? (
            <ProjectHome />
          ) : activeStage === "script" ? (
            <ScriptStage />
          ) : activeStage === "cast" ? (
            <CastStage />
          ) : activeStage === "storyboard" ? (
            <StoryboardStage />
          ) : activeStage === "delivery" && workspace.episodes.length >= 2 ? (
            <DeliveryStage />
          ) : (
            <EditorStage />
          )}
        </StageContainer>
      </StudioShell>
      {readiness && <ExportModal readiness={readiness} />}
      <ModelCenterModal />
      <ConfirmJobModal />
      <BatchJobModal />
      <JobDrawer />
    </>
  );
}
