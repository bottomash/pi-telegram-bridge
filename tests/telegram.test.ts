import { fetch as undiciFetch, Response } from "undici";
import { describe, expect, it, vi } from "vitest";

import type { BridgeLogger } from "../src/config.js";
import {
  splitTelegramText,
  TelegramTransport,
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

  it("converts standard Markdown and requests Telegram MarkdownV2 parsing", async () => {
    const bodies: Array<{ chat_id: string; parse_mode?: string; text: string }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as {
        chat_id: string;
        parse_mode?: string;
        text: string;
      });
      return okResponse();
    }) as unknown as typeof undiciFetch;
    const transport = new TelegramTransport({ botToken: "token", fetchImpl });

    await transport.sendMessage(
      "123",
      "**粗体**、`代码` 和 [链接](https://example.com)",
    );

    expect(bodies).toEqual([{
      chat_id: "123",
      parse_mode: "MarkdownV2",
      text: "*粗体*、`代码` 和 [链接](https://example.com)",
    }]);
    await transport.close();
  });

  it("falls back to plain text when Telegram rejects Markdown entities", async () => {
    const bodies: Array<{ chat_id: string; parse_mode?: string; text: string }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as {
        chat_id: string;
        parse_mode?: string;
        text: string;
      });
      return bodies.length === 1
        ? new Response(JSON.stringify({
            ok: false,
            description: "Bad Request: can't parse entities",
          }), { status: 400 })
        : okResponse();
    }) as unknown as typeof undiciFetch;
    const transport = new TelegramTransport({ botToken: "token", fetchImpl });

    await transport.sendMessage("123", "**粗体**");

    expect(bodies).toEqual([
      { chat_id: "123", parse_mode: "MarkdownV2", text: "*粗体*" },
      { chat_id: "123", text: "**粗体**" },
    ]);
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

  it("does not split surrogate pairs", () => {
    const chunks = splitTelegramText("😀😀😀", 2);
    expect(chunks).toEqual(["😀😀", "😀"]);
  });
});
