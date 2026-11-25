import { useEffect, useState, type ReactNode } from "react";

const EXIT_MS = 170;

export function useAnimatedPresence(open: boolean): { rendered: boolean; state: "open" | "closing" } {
  const [rendered, setRendered] = useState(open);
  const [state, setState] = useState<"open" | "closing">(open ? "open" : "closing");

  useEffect(() => {
    if (open) {
      setRendered(true);
      setState("open");
      return;
    }
    if (!rendered) return;
    setState("closing");
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setRendered(false), reduced ? 0 : EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, rendered]);

  return { rendered, state };
}

export function ModalShell(props: {
  open: boolean;
  onClose: () => void;
  disableClose?: boolean;
  ariaLabel: string;
  testId?: string;
  maxWidthClass?: string;
  className?: string;
  children: ReactNode;
}) {
  const { open, onClose, disableClose = false, ariaLabel, testId, maxWidthClass = "max-w-[520px]", className = "", children } = props;
  const { rendered, state } = useAnimatedPresence(open);

  useEffect(() => {
    if (!open || disableClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, disableClose, onClose]);

  if (!rendered) return null;

  return (
    <div
      data-state={state}
      onMouseDown={(e) => {
        if (state === "open" && !disableClose && e.target === e.currentTarget) onClose();
      }}
      className="aivora-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={testId}
        data-state={state}
        className={`aivora-modal-sheet w-full ${maxWidthClass} rounded-xl overflow-hidden ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

export function DrawerShell(props: {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  testId?: string;
  widthClass?: string;
  children: ReactNode;
}) {
  const { open, onClose, ariaLabel, testId, widthClass = "max-w-[420px]", children } = props;
  const { rendered, state } = useAnimatedPresence(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!rendered) return null;

  return (
    <div
      data-state={state}
      onMouseDown={(e) => {
        if (state === "open" && e.target === e.currentTarget) onClose();
      }}
      className="aivora-modal-backdrop fixed inset-0 z-50 flex justify-end"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={testId}
        data-state={state}
        className={`aivora-drawer-panel w-full ${widthClass} h-full flex flex-col overflow-hidden`}
      >
        {children}
      </div>
    </div>
  );
}
