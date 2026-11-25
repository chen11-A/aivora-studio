import { useEffect, useState, type ReactNode } from "react";

/**
 * Two-step inline confirmation guard for destructive actions (delete shot, delete provider,
 * disconnect OAuth, clear BGM). Never interrupts flow with a modal, yet eliminates accidental 1-click loss.
 */
export function ConfirmInlineAction(props: {
  onConfirm: () => void | Promise<void>;
  confirmLabel?: string;
  title?: string;
  testId?: string;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const {
    onConfirm,
    confirmLabel = "确认删除",
    title,
    testId,
    className = "",
    disabled = false,
    children,
  } = props;
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4500);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setArmed(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [armed]);

  if (armed) {
    return (
      <span className="inline-flex items-center gap-1 aivora-icon-pop shrink-0">
        <button
          type="button"
          data-testid={testId ? `${testId}-confirm` : undefined}
          onClick={(e) => {
            e.stopPropagation();
            setArmed(false);
            void onConfirm();
          }}
          className="aivora-pressable h-6 px-2 rounded-md bg-[var(--accent-danger)] hover:bg-[var(--accent-danger-hover)] text-white text-[10px] font-semibold cursor-pointer whitespace-nowrap"
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setArmed(false);
          }}
          className="aivora-pressable h-6 px-1.5 rounded-md bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-[10px] cursor-pointer whitespace-nowrap"
        >
          取消
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        setArmed(true);
      }}
      className={`aivora-pressable ${className}`}
    >
      {children}
    </button>
  );
}
