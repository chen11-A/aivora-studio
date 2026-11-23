import { useEffect } from "react";
import { StudioShell } from "./components/StudioShell";
import { CastStage } from "./features/cast/CastStage";
import { EditorStage } from "./features/editor/EditorStage";
import { ProjectHome } from "./features/home/ProjectHome";
import { ModelCenterModal } from "./features/models/ModelCenterModal";
import { ScriptStage } from "./features/script/ScriptStage";
import { StoryboardStage } from "./features/storyboard/StoryboardStage";
import { useStudioStore } from "./store/useStudioStore";

export function App() {
  const workspace = useStudioStore((s) => s.workspace);
  const activeStage = useStudioStore((s) => s.activeStage);
  const bootstrap = useStudioStore((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

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
    </>
  );
}
