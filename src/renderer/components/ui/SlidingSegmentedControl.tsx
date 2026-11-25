import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type SegmentedOption<T extends string> = {
  id: T;
  testId?: string;
  content: (active: boolean) => ReactNode;
};

/**
 * Apple-style segmented control with a GPU-accelerated sliding indicator pill (`translate3d`).
 * Measures exact button geometry via ResizeObserver; zero layout thrashing, 100% interruptible.
 */
export function SlidingSegmentedControl<T extends string>(props: {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  buttonClassName?: string;
}) {
  const { options, value, onChange, ariaLabel, className = "", buttonClassName = "" } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pill, setPill] = useState<{ x: number; width: number; ready: boolean }>({
    x: 0,
    width: 0,
    ready: false,
  });

  const measure = useCallback(() => {
    const container = containerRef.current;
    const activeBtn = btnRefs.current[value];
    if (!container || !activeBtn) return;
    const cRect = container.getBoundingClientRect();
    const bRect = activeBtn.getBoundingClientRect();
    setPill({
      x: bRect.left - cRect.left - container.clientLeft,
      width: bRect.width,
      ready: true,
    });
  }, [value]);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(container);
    return () => ro.disconnect();
  }, [measure, options.length]);

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`relative inline-flex items-center gap-0.5 p-1 rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] ${className}`}
    >
      {pill.ready && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1 bottom-1 left-0 rounded-md bg-[var(--accent-primary)] shadow-sm"
          style={{
            width: `${pill.width}px`,
            transform: `translate3d(${pill.x}px, 0, 0)`,
            transition:
              "transform var(--dur-fast) var(--ease-spring), width var(--dur-fast) var(--ease-spring)",
            willChange: "transform",
            contain: "layout style",
          }}
        />
      )}
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            ref={(el) => {
              btnRefs.current[opt.id] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={opt.testId}
            onClick={() => onChange(opt.id)}
            className={`aivora-pressable relative z-10 flex items-center justify-center gap-1.5 h-7 px-3 rounded-md text-[12px] font-medium whitespace-nowrap cursor-pointer ${
              active
                ? "text-white"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            } ${buttonClassName}`}
          >
            {opt.content(active)}
          </button>
        );
      })}
    </div>
  );
}
