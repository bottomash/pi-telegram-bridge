import { fetch as undiciFetch, Response } from "undici";
import { describe, expect, it, vi } from "vitest";

import type { BridgeLogger } from "../src/config.js";
import {
  splitTelegramText,
  TelegramTransport,
  toTelegramFormattedText,
  toTelegramMarkdown,
} from "../src/telegram.js";

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true, result: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("TelegramTransport", () => {
  it("splits long Unicode text safely and sends chunks in order", async () => {
    const bodies: Array<{ chat_id: string; text: string }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { chat_id: string; text: string });
      return okResponse();
    }) as unknown as typeof undiciFetch;
    const transport = new TelegramTransport({
      botToken: "token",
      fetchImpl,
      maxCodePoints: 5,
    });

    await transport.sendMessage("123", "甲乙\n丙丁😀戊己庚");

    expect(bodies.map((body) => body.text)).toEqual(["甲乙\n", "丙丁😀戊己", "庚"]);
    expect(bodies.every((body) => body.chat_id === "123")).toBe(true);
    expect(bodies.map((body) => Array.from(body.text).join(""))).toEqual(bodies.map((body) => body.text));
    await transport.close();
  });

  it("sends standard Markdown as explicit Telegram entities", async () => {
    const bodies: Array<{
      chat_id: string;
      entities?: Array<{ type: string; offset: number; length: number; url?: string }>;
      text: string;
    }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return okResponse();
    }) as unknown as typeof undiciFetch;
    const transport = new TelegramTransport({ botToken: "token", fetchImpl });

    await transport.sendMessage(
      "123",
      "**粗体**、`代码` 和 [链接](https://example.com)",
    );

    expect(bodies).toEqual([{
      chat_id: "123",
      text: "粗体、代码 和 链接",
      entities: [
        { type: "bold", offset: 0, length: 2 },
        { type: "code", offset: 3, length: 2 },
        { type: "text_link", offset: 8, length: 2, url: "https://example.com" },
      ],
    }]);
    await transport.close();
  });

  it("splits formatted text without cutting or invalidating entities", async () => {
    const bodies: Array<{
      chat_id: string;
      entities?: Array<{ type: string; offset: number; length: number }>;
      text: string;
    }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return okResponse();
    }) as unknown as typeof undiciFetch;
    const transport = new TelegramTransport({ botToken: "token", fetchImpl, maxCodePoints: 4 });

    await transport.sendMessage("123", "**甲乙丙丁戊己**");

    expect(bodies).toEqual([
      {
        chat_id: "123",
        text: "甲乙丙丁",
        entities: [{ type: "bold", offset: 0, length: 4 }],
      },
      {
        chat_id: "123",
        text: "戊己",
        entities: [{ type: "bold", offset: 0, length: 2 }],
      },
    ]);
    await transport.close();
  });

  it("keeps every request within Telegram's 100-entity limit", async () => {
    const bodies: Array<{
      entities?: Array<{ type: string; offset: number; length: number }>;
      text: string;
    }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return okResponse();
    }) as unknown as typeof undiciFetch;
    const transport = new TelegramTransport({ botToken: "token", fetchImpl });
    const message = Array.from({ length: 101 }, (_, index) => `**${index}**`).join(" ");

    await transport.sendMessage("123", message);

    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((body) => (body.entities?.length ?? 0) <= 100)).toBe(true);
    expect(bodies.map((body) => body.text).join("")).toBe(
      Array.from({ length: 101 }, (_, index) => String(index)).join(" "),
    );
    await transport.close();
  });

  it("logs Telegram's reason and falls back when explicit entities are rejected", async () => {
    const bodies: Array<{
      chat_id: string;
      entities?: Array<{ type: string; offset: number; length: number }>;
      text: string;
    }> = [];
    const logs: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return bodies.length === 1
        ? new Response(JSON.stringify({
            ok: false,
            description: "Bad Request: can't parse entities at byte offset 4",
          }), { status: 400 })
        : okResponse();
    }) as unknown as typeof undiciFetch;
    const transport = new TelegramTransport({
      botToken: "token",
      fetchImpl,
      logger: {
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
    });

    await transport.sendMessage("123", "**粗体**");

    expect(bodies).toEqual([
      {
        chat_id: "123",
        text: "粗体",
        entities: [{ type: "bold", offset: 0, length: 2 }],
      },
      { chat_id: "123", text: "粗体" },
    ]);
    expect(logs).toContain(
      "[telegram] formatting entities rejected (Bad Request: can't parse entities at byte offset 4); retrying as plain text",
    );
    await transport.close();
  });

  it("downloads a Telegram photo as Pi image content", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { file_path: "photos/receipt.jpg" },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })) as unknown as typeof undiciFetch;
    const transport = new TelegramTransport({ botToken: "123:token", fetchImpl });

    await expect(transport.downloadImage("photo-id")).resolves.toEqual({
      type: "image",
      data: Buffer.from([1, 2, 3]).toString("base64"),
      mimeType: "image/jpeg",
    });

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0]?.[0])).toBe("https://api.telegram.org/bot123:token/getFile");
    expect(JSON.parse(String((calls[0]?.[1] as RequestInit | undefined)?.body))).toEqual({
      file_id: "photo-id",
    });
    expect(String(calls[1]?.[0])).toBe(
      "https://api.telegram.org/file/bot123:token/photos/receipt.jpg",
    );
    await transport.close();
  });

  it("registers the public URL and secret with Telegram setWebhook", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof undiciFetch;
    const transport = new TelegramTransport({ botToken: "123:token", fetchImpl });

    await transport.setWebhook(
      "https://tg.example.com/telegram/webhook",
      "webhook-secret",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.telegram.org/bot123:token/setWebhook");
    expect(JSON.parse(String((init as RequestInit | undefined)?.body))).toEqual({
      url: "https://tg.example.com/telegram/webhook",
      secret_token: "webhook-secret",
    });
    await transport.close();
  });

  it("retries temporary failures with bounded backoff", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 502 }))
      .mockResolvedValueOnce(okResponse()) as unknown as typeof undiciFetch;
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const transport = new TelegramTransport({ botToken: "token", fetchImpl, sleep });

    await transport.sendMessage("123", "answer");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1000, 2000]);
    await transport.close();
  });

  it("honors Telegram 429 retry_after", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: false, parameters: { retry_after: 7 } }),
        { status: 429 },
      ))
      .mockResolvedValueOnce(okResponse()) as unknown as typeof undiciFetch;
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const transport = new TelegramTransport({ botToken: "token", fetchImpl, sleep });

    await transport.sendMessage("123", "answer");

    expect(sleep).toHaveBeenCalledWith(7000);
    await transport.close();
  });

  it("does not retry a permanent Telegram 4xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, description: "Bad Request" }),
      { status: 400 },
    )) as unknown as typeof undiciFetch;
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const transport = new TelegramTransport({ botToken: "token", fetchImpl, sleep });

    await expect(transport.sendMessage("123", "answer")).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    await transport.close();
  });

  it("never writes the bot token or secret-like error text to logs", async () => {
    const botToken = "123:SUPER_SECRET_TOKEN";
    const webhookSecret = "WEBHOOK_SECRET";
    const logs: string[] = [];
    const logger: BridgeLogger = {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    };
    const fetchImpl = vi.fn(async () => {
      throw new Error(`failed https://api.telegram.org/bot${botToken}/sendMessage ${webhookSecret}`);
    }) as unknown as typeof undiciFetch;
    const transport = new TelegramTransport({
      botToken,
      fetchImpl,
      sleep: async () => undefined,
      logger,
    });

    await expect(transport.sendMessage("123", "answer")).rejects.toThrow();
    const output = logs.join("\n");
    expect(output).not.toContain(botToken);
    expect(output).not.toContain(webhookSecret);
    await transport.close();
  });
});

describe("Markdown helpers", () => {
  it("escapes Telegram MarkdownV2 reserved characters", () => {
    expect(toTelegramMarkdown("plain + dash - dot.")).toBe(
      "plain \\+ dash \\- dot\\.",
    );
  });

  it("converts nested formatting, links, quotes, and escapes into explicit entities", () => {
    expect(toTelegramFormattedText(
      "> **粗体和 _斜体_**\n\n[链接](https://example.com/a_(b)) 与 a_b",
    )).toEqual({
      text: "粗体和 斜体\n\n链接 与 a_b",
      entities: [
        { type: "bold", offset: 0, length: 6 },
        { type: "blockquote", offset: 0, length: 6 },
        { type: "italic", offset: 4, length: 2 },
        { type: "text_link", offset: 8, length: 2, url: "https://example.com/a_(b)" },
      ],
    });
  });

  it("renders Markdown tables as monospaced preformatted text", () => {
    const formatted = toTelegramFormattedText([
      "| Name | Value |",
      "| --- | ---: |",
      "| Alpha | 123 |",
      "| 中文 | 456 |",
    ].join("\n"));

    expect(formatted.text).toContain("| Name");
    expect(formatted.text).toContain("| 中文");
    expect(formatted.entities).toEqual([{
      type: "pre",
      offset: 0,
      length: formatted.text.length,
    }]);
  });

  it("drops unsupported style overlap while preserving code formatting", () => {
    expect(toTelegramFormattedText("**before `code` after**")).toEqual({
      text: "before code after",
      entities: [{ type: "code", offset: 7, length: 4 }],
    });
  });

  it("does not split surrogate pairs", () => {
    const chunks = splitTelegramText("😀😀😀", 2);
    expect(chunks).toEqual(["😀😀", "😀"]);
  });
});
