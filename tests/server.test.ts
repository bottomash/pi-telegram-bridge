import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { UpdateDedupe } from "../src/dedupe.js";
import { handleWebhookRequest } from "../src/server.js";
import type { TelegramJob } from "../src/telegram.js";

const SECRET = "test-secret";
const CHAT_ID = "123456789";

interface Harness {
  url: string;
  close(): Promise<void>;
}

const openServers: Harness[] = [];

async function startHarness(onMessage: (job: TelegramJob) => void | Promise<void>): Promise<Harness> {
  const dedupe = new UpdateDedupe();
  const server = createServer((request, response) => {
    void handleWebhookRequest(request, response, {
      webhookSecret: SECRET,
      allowedChatId: CHAT_ID,
      dedupe,
      onMessage,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  const harness = {
    url: `http://127.0.0.1:${address.port}/telegram/webhook`,
    close: () => closeServer(server),
  };
  openServers.push(harness);
  return harness;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function post(
  url: string,
  body: unknown,
  secret = SECRET,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  const servers = openServers.splice(0);
  await Promise.all(servers.map((server) => server.close()));
});

describe("Telegram webhook", () => {
  it("accepts an authorized private text and returns before async processing finishes", async () => {
    const received: TelegramJob[] = [];
    const harness = await startHarness((job) => {
      received.push(job);
      return new Promise<void>(() => undefined);
    });

    const response = await post(harness.url, {
      update_id: 101,
      message: { chat: { id: 123456789, type: "private" }, text: "hello" },
    });

    expect(response.status).toBe(200);
    expect(received).toEqual([{ updateId: 101, chatId: CHAT_ID, text: "hello" }]);
  });

  it("rejects an invalid webhook secret", async () => {
    const onMessage = vi.fn();
    const harness = await startHarness(onMessage);
    const response = await post(
      harness.url,
      { update_id: 102, message: { chat: { id: 123456789, type: "private" }, text: "x" } },
      "wrong-secret",
    );

    expect(response.status).toBe(403);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("silently ignores a different chat id", async () => {
    const onMessage = vi.fn();
    const harness = await startHarness(onMessage);
    const response = await post(harness.url, {
      update_id: 103,
      message: { chat: { id: 999, type: "private" }, text: "x" },
    });

    expect(response.status).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("accepts a private photo with its caption and selects the largest size", async () => {
    const received: TelegramJob[] = [];
    const harness = await startHarness((job) => {
      received.push(job);
    });

    const response = await post(harness.url, {
      update_id: 104,
      message: {
        chat: { id: 123456789, type: "private" },
        caption: "识别并记账",
        photo: [
          { file_id: "small", width: 320, height: 240, file_size: 1000 },
          { file_id: "large", width: 1280, height: 960, file_size: 8000 },
        ],
      },
    });

    expect(response.status).toBe(200);
    expect(received).toEqual([{
      updateId: 104,
      chatId: CHAT_ID,
      text: "识别并记账",
      image: { fileId: "large", mimeType: "image/jpeg" },
    }]);
  });

  it("adds the accounting prompt when a private photo has no caption", async () => {
    const received: TelegramJob[] = [];
    const harness = await startHarness((job) => {
      received.push(job);
    });

    await post(harness.url, {
      update_id: 105,
      message: {
        chat: { id: 123456789, type: "private" },
        photo: [{ file_id: "receipt", width: 800, height: 600 }],
      },
    });

    expect(received[0]?.text).toContain("记账");
    expect(received[0]?.image?.fileId).toBe("receipt");
  });

  it("ignores unsupported media and non-private updates", async () => {
    const onMessage = vi.fn();
    const harness = await startHarness(onMessage);
    const sticker = await post(harness.url, {
      update_id: 106,
      message: { chat: { id: 123456789, type: "private" }, sticker: {} },
    });
    const group = await post(harness.url, {
      update_id: 107,
      message: { chat: { id: 123456789, type: "group" }, text: "x" },
    });

    expect(sticker.status).toBe(200);
    expect(group.status).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("processes a repeated update_id only once", async () => {
    const onMessage = vi.fn();
    const harness = await startHarness(onMessage);
    const update = {
      update_id: 108,
      message: { chat: { id: 123456789, type: "private" }, text: "once" },
    };

    expect((await post(harness.url, update)).status).toBe(200);
    expect((await post(harness.url, update)).status).toBe(200);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});
