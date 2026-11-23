/**
 * Ported & streamlined sequential per-key persistence queue from aijian-studio film-persistence.ts.
 * Guarantees:
 * 1. Writes for the same key run strictly in order (no out-of-order overwrites).
 * 2. A failed write rejects its caller without poisoning later saves.
 * 3. `flushAll()` awaits every pending save and reports failure so episode/project switches
 *    can block navigation instead of silently dropping unsaved edits.
 */
export type SaveState = "idle" | "saving" | "saved" | "error";

export interface PersistenceQueue {
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T>;
  flushAll(): Promise<{ ok: true } | { ok: false; failedKey: string; error: Error }>;
  hasPending(): boolean;
}

export function createPersistenceQueue(): PersistenceQueue {
  type Entry = {
    tail: Promise<void>;
    inFlight: number;
    lastError: Error | null;
  };

  const entries = new Map<string, Entry>();

  const getEntry = (key: string): Entry => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { tail: Promise.resolve(), inFlight: 0, lastError: null };
      entries.set(key, entry);
    }
    return entry;
  };

  return {
    enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
      const entry = getEntry(key);
      entry.inFlight += 1;
      const run = entry.tail.then(async () => {
        try {
          const result = await task();
          entry.lastError = null;
          return result;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          entry.lastError = error;
          throw error;
        } finally {
          entry.inFlight = Math.max(0, entry.inFlight - 1);
        }
      });
      // Prevent one rejected promise from poisoning subsequent writes on the same key.
      entry.tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    async flushAll(): Promise<{ ok: true } | { ok: false; failedKey: string; error: Error }> {
      await Promise.all([...entries.values()].map((e) => e.tail));
      for (const [key, entry] of entries.entries()) {
        if (entry.lastError) {
          return { ok: false, failedKey: key, error: entry.lastError };
        }
      }
      return { ok: true };
    },

    hasPending(): boolean {
      for (const entry of entries.values()) {
        if (entry.inFlight > 0) return true;
      }
      return false;
    },
  };
}
