export type ThemeMode = "system" | "dark" | "light";

const STORAGE_KEY = "aivora-theme-mode";
const listeners = new Set<() => void>();
let initialized = false;

export function getStoredThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "dark" || raw === "light" || raw === "system") return raw;
  } catch {
    // ignore storage restrictions
  }
  return "dark";
}

export function resolveEffectiveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "dark" || mode === "light") return mode;
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

export function applyThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore storage restrictions
  }
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolveEffectiveTheme(mode);
  }
  for (const fn of listeners) fn();
}

export function cycleThemeMode(current: ThemeMode): ThemeMode {
  if (current === "dark") return "light";
  if (current === "light") return "system";
  return "dark";
}

export function initTheme(): void {
  if (typeof document === "undefined") return;
  const mode = getStoredThemeMode();
  document.documentElement.dataset.theme = resolveEffectiveTheme(mode);
  if (initialized) return;
  initialized = true;
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  mq?.addEventListener?.("change", () => {
    if (getStoredThemeMode() === "system") {
      document.documentElement.dataset.theme = resolveEffectiveTheme("system");
      for (const fn of listeners) fn();
    }
  });
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
