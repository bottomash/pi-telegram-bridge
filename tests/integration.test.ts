import { describe, expect, it, vi } from "vitest";

import { PI_FAILURE_MESSAGE, processTelegramJob } from "../src/index.js";
import type { TelegramJob } from "../src/telegram.js";

const job: TelegramJob = { updateId: 1, chatId: "123", text: "question" };

describe("processTelegramJob", () => {
  it("sends the Pi final answer once to the original chat", async () => {
    const piRunner = { run: vi.fn(async () => ({ text: "final answer" })) };
    const telegram = { sendMessage: vi.fn(async () => undefined) };

    await processTelegramJob(job, piRunner, telegram);

    expect(piRunner.run).toHaveBeenCalledWith("question");
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith("123", "final answer");
  });

  it("sends the fixed failure reply when Pi fails", async () => {
    const piRunner = { run: vi.fn(async () => { throw new Error("private failure"); }) };
    const telegram = { sendMessage: vi.fn(async () => undefined) };

    await processTelegramJob(job, piRunner, telegram);

    expect(telegram.sendMessage).toHaveBeenCalledWith("123", PI_FAILURE_MESSAGE);
  });
});
