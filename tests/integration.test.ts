import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { quietConsoleLogger } from "../src/config.js";
import telegramBridgeExtension, { PI_FAILURE_MESSAGE, processTelegramJob } from "../src/index.js";
import type { TelegramJob } from "../src/telegram.js";

const job: TelegramJob = { updateId: 1, chatId: "123", text: "question" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("telegramBridgeExtension", () => {
  it("keeps routine bridge activity out of the Pi conversation", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const piRunner = { run: vi.fn(async () => ({ text: "final answer" })) };
    const telegram = { sendMessage: vi.fn(async () => undefined) };

    await processTelegramJob(job, piRunner, telegram, quietConsoleLogger);

    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("registers lifecycle commands and stays stopped when a session starts", async () => {
    const commands = new Map<string, { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }>();
    const events = new Map<string, Array<(event: unknown, context: ExtensionContext) => Promise<void> | void>>();
    const pi = {
      registerCommand: vi.fn((name: string, command: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }) => {
        commands.set(name, command);
      }),
      on: vi.fn((name: string, handler: (event: unknown, context: ExtensionContext) => Promise<void> | void) => {
        const handlers = events.get(name) ?? [];
        handlers.push(handler);
        events.set(name, handlers);
        return () => undefined;
      }),
      sendUserMessage: vi.fn(),
    };

    telegramBridgeExtension(pi as unknown as ExtensionAPI);

    expect(commands.has("pi-telegram-bridge")).toBe(true);
    expect(commands.has("pi-telegram-bridge-setup")).toBe(true);

    const notify = vi.fn();
    const context = {
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext;
    for (const handler of events.get("session_start") ?? []) {
      await handler({}, context as unknown as ExtensionContext);
    }
    await commands.get("pi-telegram-bridge")?.handler("status", context);

    expect(notify).toHaveBeenCalledWith("Telegram Bridge 当前未运行", "info");
  });
});

describe("processTelegramJob", () => {
  it("sends the Pi final answer once to the original chat", async () => {
    const piRunner = { run: vi.fn(async () => ({ text: "final answer" })) };
    const telegram = { sendMessage: vi.fn(async () => undefined) };

    await processTelegramJob(job, piRunner, telegram);

    expect(piRunner.run).toHaveBeenCalledWith("question");
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledWith("123", "final answer");
  });

  it("downloads a photo and sends it to Pi with the accounting prompt", async () => {
    const image = {
      type: "image" as const,
      data: "AQID",
      mimeType: "image/jpeg",
    };
    const imageJob: TelegramJob = {
      updateId: 2,
      chatId: "123",
      text: "识别并记账",
      image: { fileId: "photo-id", mimeType: "image/jpeg" },
    };
    const piRunner = { run: vi.fn(async () => ({ text: "已记账" })) };
    const telegram = {
      downloadImage: vi.fn(async () => image),
      sendMessage: vi.fn(async () => undefined),
    };

    await processTelegramJob(imageJob, piRunner, telegram);

    expect(telegram.downloadImage).toHaveBeenCalledWith("photo-id");
    expect(piRunner.run).toHaveBeenCalledWith([
      { type: "text", text: "识别并记账" },
      image,
    ]);
    expect(telegram.sendMessage).toHaveBeenCalledWith("123", "已记账");
  });

  it("sends the fixed failure reply when Pi fails", async () => {
    const piRunner = { run: vi.fn(async () => { throw new Error("private failure"); }) };
    const telegram = { sendMessage: vi.fn(async () => undefined) };

    await processTelegramJob(job, piRunner, telegram);

    expect(telegram.sendMessage).toHaveBeenCalledWith("123", PI_FAILURE_MESSAGE);
  });
});
