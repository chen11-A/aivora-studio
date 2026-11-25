import { useState, type ReactNode } from "react";

const ORDER: Record<string, number> = {
  home: 0,
  script: 1,
  cast: 2,
  storyboard: 3,
  editor: 4,
};

type StageDir = "forward" | "backward" | "neutral";

function computeDir(prevKey: string, nextKey: string): StageDir {
  const prevOrder = ORDER[prevKey] ?? 0;
  const nextOrder = ORDER[nextKey] ?? 0;
  if (prevKey !== nextKey && prevOrder > 0 && nextOrder > 0) {
    return nextOrder > prevOrder ? "forward" : "backward";
  }
  return "neutral";
}

export function StageContainer(props: { viewKey: string; children: ReactNode }) {
  const [transition, setTransition] = useState<{ viewKey: string; dir: StageDir }>({
    viewKey: props.viewKey,
    dir: "neutral",
  });

  if (props.viewKey !== transition.viewKey) {
    setTransition({
      viewKey: props.viewKey,
      dir: computeDir(transition.viewKey, props.viewKey),
    });
  }

  const animClass =
    transition.dir === "forward"
      ? "aivora-stage-forward"
      : transition.dir === "backward"
        ? "aivora-stage-backward"
        : "aivora-stage-neutral";

  return (
    <div key={transition.viewKey} className={`h-full w-full min-h-0 min-w-0 overflow-hidden ${animClass}`}>
      {props.children}
    </div>
  );
}
