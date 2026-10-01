import { describe, expect, it } from "vitest";

import { FifoQueue } from "../src/queue.js";

describe("FifoQueue", () => {
  it("runs two messages in FIFO order without overlap", async () => {
    const queue = new FifoQueue<void>();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      events.push("A:start");
      await firstGate;
      events.push("A:end");
    });
    const second = queue.enqueue(async () => {
      events.push("B:start");
      events.push("B:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["A:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });
});
