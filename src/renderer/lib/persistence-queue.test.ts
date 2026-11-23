import { describe, expect, it } from "vitest";
import { createPersistenceQueue } from "./persistence-queue";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createPersistenceQueue", () => {
  it("runs writes for the same key strictly in FIFO order", async () => {
    const queue = createPersistenceQueue();
    const order: string[] = [];

    const p1 = queue.enqueue("ep-1", async () => {
      await delay(30);
      order.push("first");
      return 1;
    });
    const p2 = queue.enqueue("ep-1", async () => {
      await delay(5);
      order.push("second");
      return 2;
    });

    expect(await Promise.all([p1, p2])).toEqual([1, 2]);
    expect(order).toEqual(["first", "second"]);
    expect(await queue.flushAll()).toEqual({ ok: true });
  });

  it("blocks flushAll after a write error without poisoning a subsequent retry", async () => {
    const queue = createPersistenceQueue();

    const failing = queue.enqueue("shot-1", async () => {
      await delay(10);
      throw new Error("磁盘已满");
    });
    await expect(failing).rejects.toThrow("磁盘已满");

    const blocked = await queue.flushAll();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.failedKey).toBe("shot-1");
      expect(blocked.error.message).toBe("磁盘已满");
    }

    // Retry save succeeds and clears error state so episode switch can proceed
    await expect(queue.enqueue("shot-1", async () => "saved")).resolves.toBe("saved");
    expect(await queue.flushAll()).toEqual({ ok: true });
    expect(queue.hasPending()).toBe(false);
  });
});
