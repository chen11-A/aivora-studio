import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type SegmentedOption<T extends string> = {
  id: T;
  testId?: string;
  content: (active: boolean) => ReactNode;
};

/**
 * Apple-style segmented control with a GPU-accelerated sliding indicator pill (`translate3d`).
 * Measures unscaled `offsetLeft`/`offsetWidth` (immune to modal scale entrance transforms),
 * snaps immediately on mount/resize without lag, supports full WAI-ARIA tablist arrow keys,
 * and hides cleanly when `value` is outside preset options (e.g., custom shot duration).
 */
export function SlidingSegmentedControl<T extends string>(props: {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  tone?: "primary" | "surface";
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
}) {
  const {
    options,
    value,
    onChange,
    ariaLabel,
    size = "md",
    tone = "primary",
    fullWidth = false,
    disabled = false,
    className = "",
    buttonClassName = "",
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const prevValueRef = useRef<T>(value);
  const hasMeasuredRef = useRef(false);
  const [pill, setPill] = useState<{ x: number; width: number; ready: boolean; animated: boolean }>({
    x: 0,
    width: 0,
    ready: false,
    animated: false,
  });

  const measure = useCallback(
    (animate: boolean) => {
      const activeBtn = btnRefs.current[value];
      if (!activeBtn) {
        setPill((prev) => (prev.ready ? { ...prev, ready: false } : prev));
        return;
      }
      const x = activeBtn.offsetLeft;
      const width = activeBtn.offsetWidth;
      if (width <= 0) return;
      const shouldAnimate = animate && hasMeasuredRef.current;
      hasMeasuredRef.current = true;
      setPill((prev) =>
        prev.ready && prev.x === x && prev.width === width && prev.animated === shouldAnimate
          ? prev
          : { x, width, ready: true, animated: shouldAnimate },
      );
    },
    [value],
  );

  useLayoutEffect(() => {
    const valueChanged = prevValueRef.current !== value;
    prevValueRef.current = value;
    measure(valueChanged);

    const container = containerRef.current;
    const activeBtn = btnRefs.current[value];
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure(false));
    ro.observe(container);
    if (activeBtn) ro.observe(activeBtn);
    return () => ro.disconnect();
  }, [measure, value, options.length]);

  const activeIdx = options.findIndex((o) => o.id === value);

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, idx: number) {
    if (disabled || options.length <= 1) return;
    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % options.length;
    else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + options.length) % options.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = options.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const target = options[nextIdx];
    if (!target) return;
    onChange(target.id);
    btnRefs.current[target.id]?.focus();
  }

  const hasCustomPx = /\bpx-/.test(buttonClassName);
  const hasCustomText = /\btext-/.test(buttonClassName);
  const padClass = size === "sm" ? "p-0.5 rounded-lg" : "p-1 rounded-lg";
  const pillInsetClass = size === "sm" ? "top-0.5 bottom-0.5 rounded-md" : "top-1 bottom-1 rounded-md";
  const btnHeightClass = [
    size === "sm" ? "h-6" : "h-7",
    !hasCustomPx ? (size === "sm" ? "px-2" : "px-3") : "",
    !hasCustomText ? (size === "sm" ? "text-[11px]" : "text-[12px]") : "",
  ]
    .filter(Boolean)
    .join(" ");
  const pillColorClass =
    tone === "primary"
      ? "bg-[var(--accent-primary)] shadow-sm"
      : "bg-[var(--bg-elevated)] border border-[var(--border-subtle)] shadow-xs";

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`relative items-center gap-0.5 bg-[var(--bg-inset)] border border-[var(--border-subtle)] ${padClass} ${
        fullWidth ? "flex w-full" : "inline-flex"
      } ${className}`}
    >
      {pill.ready && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute left-0 ${pillInsetClass} ${pillColorClass}`}
          style={{
            width: `${pill.width}px`,
            transform: `translate3d(${pill.x}px, 0, 0)`,
            transition: pill.animated
              ? "transform var(--dur-fast) var(--ease-spring), width var(--dur-fast) var(--ease-spring)"
              : "none",
            willChange: "transform",
            contain: "layout style",
          }}
        />
      )}
      {options.map((opt, idx) => {
        const active = opt.id === value;
        const tabIndex = active || (activeIdx === -1 && idx === 0) ? 0 : -1;
        const activeText =
          tone === "primary"
            ? "text-white font-semibold"
            : "text-[var(--text-primary)] font-semibold";
        return (
          <button
            key={opt.id}
            ref={(el) => {
              btnRefs.current[opt.id] = el;
            }}
            type="button"
            role="tab"
            tabIndex={tabIndex}
            disabled={disabled}
            aria-selected={active}
            data-testid={opt.testId}
            onClick={() => onChange(opt.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={`aivora-pressable relative z-10 flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${btnHeightClass} ${
              fullWidth ? "flex-1 min-w-0" : ""
            } ${
              active ? activeText : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            } ${buttonClassName}`}
          >
            {opt.content(active)}
          </button>
        );
      })}
    </div>
  );
}
