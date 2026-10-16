import { fetch as undiciFetch, Response } from "undici";
import { describe, expect, it, vi } from "vitest";

import type { BridgeLogger } from "../src/config.js";
import { LongPollingReceiver } from "../src/polling.js";
import { TelegramTransport, type TelegramJob } from "../src/telegram.js";

function telegramResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const quietLogger: BridgeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("LongPollingReceiver", () => {
  it("removes an existing webhook and receives only allowed private text", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let releaseMessage: (() => void) | undefined;
    const messageReceived = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      if (requests.length === 1) {
        return telegramResponse(true);
      }
      if (requests.length === 2) {
        return telegramResponse([
          {
            update_id: 10,
            message: { chat: { id: 123, type: "private" }, text: "hello" },
          },
          {
            update_id: 11,
            message: { chat: { id: 999, type: "private" }, text: "ignored" },
          },
        ]);
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as unknown as typeof undiciFetch;
    const transport = new TelegramTransport({ botToken: "token", fetchImpl, logger: quietLogger });
    const jobs: TelegramJob[] = [];
    const receiver = new LongPollingReceiver({
      transport,
      allowedChatId: "123",
      logger: quietLogger,
      onMessage: (job) => {
        jobs.push(job);
        releaseMessage?.();
      },
    });

    await receiver.start();
    await messageReceived;
    await receiver.stop();
    await transport.close();

    expect(jobs).toEqual([{ updateId: 10, chatId: "123", text: "hello" }]);
    expect(requests[0]).toEqual({
      url: "https://api.telegram.org/bottoken/deleteWebhook",
      body: { drop_pending_updates: false },
    });
    expect(requests[1]).toEqual({
      url: "https://api.telegram.org/bottoken/getUpdates",
      body: { timeout: 30, allowed_updates: ["message"] },
    });
  });
});
