import { useEffect } from "react";
import { BatchJobModal } from "./components/BatchJobModal";
import { ConfirmJobModal } from "./components/ConfirmJobModal";
import { JobDrawer } from "./components/JobDrawer";
import { StudioShell } from "./components/StudioShell";
import { CastStage } from "./features/cast/CastStage";
import { EditorStage } from "./features/editor/EditorStage";
import { ProjectHome } from "./features/home/ProjectHome";
import { ModelCenterModal } from "./features/models/ModelCenterModal";
import { ScriptStage } from "./features/script/ScriptStage";
import { StoryboardStage } from "./features/storyboard/StoryboardStage";
import { getDesktopClient } from "./lib/desktop-client";
import { flushPendingSaves, useStudioStore } from "./store/useStudioStore";

export function App() {
  const workspace = useStudioStore((s) => s.workspace);
  const activeStage = useStudioStore((s) => s.activeStage);
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

  return (
    <>
      <StudioShell>
        {!workspace ? (
          <ProjectHome />
        ) : activeStage === "script" ? (
          <ScriptStage />
        ) : activeStage === "cast" ? (
          <CastStage />
        ) : activeStage === "storyboard" ? (
          <StoryboardStage />
        ) : (
          <EditorStage />
        )}
      </StudioShell>
      <ModelCenterModal />
      <ConfirmJobModal />
      <BatchJobModal />
      <JobDrawer />
    </>
  );
}
