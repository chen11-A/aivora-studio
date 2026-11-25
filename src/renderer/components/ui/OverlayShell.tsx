import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

const EXIT_MS = 170;

type EscapeLayerEntry = {
  id: symbol;
  onClose: () => void;
};

const escapeStack: EscapeLayerEntry[] = [];
let globalEscapeBound = false;

function handleGlobalEscape(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.onClose();
}

function syncGlobalEscapeListener() {
  if (typeof window === "undefined") return;
  if (escapeStack.length > 0 && !globalEscapeBound) {
    window.addEventListener("keydown", handleGlobalEscape);
    globalEscapeBound = true;
  } else if (escapeStack.length === 0 && globalEscapeBound) {
    window.removeEventListener("keydown", handleGlobalEscape);
    globalEscapeBound = false;
  }
}

export function useEscapeLayer(
  active: boolean,
  onClose: () => void,
  options?: {
    disableClose?: boolean;
    restoreFocus?: boolean;
    containerRef?: RefObject<HTMLElement | null>;
  },
) {
  const { disableClose = false, restoreFocus = true, containerRef } = options ?? {};
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const prevFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    if (restoreFocus && typeof document !== "undefined") {
      prevFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }

    const focusRaf =
      typeof requestAnimationFrame !== "undefined"
        ? requestAnimationFrame(() => {
            const container = containerRef?.current;
            if (!container || typeof document === "undefined") return;
            if (!container.contains(document.activeElement)) {
              container.focus({ preventScroll: true });
            }
          })
        : 0;

    const layerId = Symbol("escape-layer");
    if (!disableClose) {
      escapeStack.push({ id: layerId, onClose: () => onCloseRef.current() });
      syncGlobalEscapeListener();
    }

    return () => {
      if (focusRaf && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(focusRaf);
      }
      if (!disableClose) {
        const idx = escapeStack.findIndex((entry) => entry.id === layerId);
        if (idx >= 0) escapeStack.splice(idx, 1);
        syncGlobalEscapeListener();
      }
      if (restoreFocus) {
        const prev = prevFocusRef.current;
        prevFocusRef.current = null;
        if (prev && prev.isConnected) {
          if (typeof requestAnimationFrame !== "undefined") {
            requestAnimationFrame(() => {
              if (prev.isConnected) prev.focus({ preventScroll: true });
            });
          } else {
            prev.focus({ preventScroll: true });
          }
        }
      }
    };
  }, [active, disableClose, restoreFocus, containerRef]);
}

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
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useEscapeLayer(open, onClose, { disableClose, restoreFocus: true, containerRef: sheetRef });

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
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={testId}
        data-state={state}
        className={`aivora-modal-sheet outline-none w-full ${maxWidthClass} rounded-xl overflow-hidden ${className}`}
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
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEscapeLayer(open, onClose, { restoreFocus: true, containerRef: panelRef });

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
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={testId}
        data-state={state}
        className={`aivora-drawer-panel outline-none w-full ${widthClass} h-full flex flex-col overflow-hidden`}
      >
        {children}
      </div>
    </div>
  );
}
