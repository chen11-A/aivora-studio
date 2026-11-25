import { useEffect, useRef, type ReactNode } from "react";

export function CollapsibleRegion(props: {
  open: boolean;
  className?: string;
  children: ReactNode;
}) {
  const innerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (innerRef.current) {
      innerRef.current.inert = !props.open;
    }
  }, [props.open]);

  return (
    <div
      className={`aivora-collapsible ${props.className ?? ""}`}
      data-open={props.open ? "true" : "false"}
      aria-hidden={!props.open}
    >
      <div ref={innerRef} className="aivora-collapsible-inner">
        {props.children}
      </div>
    </div>
  );
}
