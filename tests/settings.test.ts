import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  generateWebhookSecret,
  loadEffectiveConfig,
  readSavedConfig,
  saveConfig,
  validateWebhookUrl,
  type CredentialStore,
} from "../src/settings.js";

const temporaryDirectories: string[] = [];

async function temporaryConfigPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-telegram-bridge-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "config.json");
}

const credentialStore: CredentialStore = {
  load: async () => ({
    botToken: "stored-token",
    webhookSecret: "stored-secret",
  }),
  save: async () => undefined,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("persistent Telegram configuration", () => {
  it("writes and reads non-secret configuration", async () => {
    const configPath = await temporaryConfigPath();
    await saveConfig({
      allowedChatId: "123456789",
      host: "127.0.0.1",
      port: 8787,
      proxy: "http://127.0.0.1:7890",
      webhookUrl: "https://tg.example.com/telegram/webhook",
    }, configPath);

    await expect(readSavedConfig(configPath)).resolves.toEqual({
      allowedChatId: "123456789",
      host: "127.0.0.1",
      port: 8787,
      proxy: "http://127.0.0.1:7890",
      webhookUrl: "https://tg.example.com/telegram/webhook",
    });
  });

  it("combines saved settings with credentials from the system store", async () => {
    const configPath = await temporaryConfigPath();
    await saveConfig({
      allowedChatId: "123456789",
      host: "127.0.0.1",
      port: 8787,
    }, configPath);

    await expect(loadEffectiveConfig({
      env: {},
      configPath,
      credentialStore,
    })).resolves.toEqual({
      botToken: "stored-token",
      allowedChatId: "123456789",
      webhookSecret: "stored-secret",
      host: "127.0.0.1",
      port: 8787,
    });
  });

  it("lets environment variables override every saved value", async () => {
    const configPath = await temporaryConfigPath();
    await saveConfig({
      allowedChatId: "111",
      host: "127.0.0.1",
      port: 8787,
      proxy: "http://127.0.0.1:7890",
    }, configPath);

    const config = await loadEffectiveConfig({
      env: {
        TELEGRAM_BOT_TOKEN: "environment-token",
        TELEGRAM_ALLOWED_CHAT_ID: "222",
        TELEGRAM_WEBHOOK_SECRET: "environment-secret",
        TELEGRAM_HOST: "localhost",
        TELEGRAM_PORT: "9000",
        TELEGRAM_PROXY: "",
      },
      configPath,
      credentialStore: {
        load: async () => {
          throw new Error("credential store should not be read");
        },
        save: async () => undefined,
      },
    });

    expect(config).toEqual({
      botToken: "environment-token",
      allowedChatId: "222",
      webhookSecret: "environment-secret",
      host: "localhost",
      port: 9000,
    });
  });

  it("validates the public Telegram Webhook URL", () => {
    expect(validateWebhookUrl(" https://tg.example.com/telegram/webhook ")).toBe(
      "https://tg.example.com/telegram/webhook",
    );
    expect(() => validateWebhookUrl("http://tg.example.com/telegram/webhook")).toThrow(
      "https://",
    );
    expect(() => validateWebhookUrl("https://tg.example.com/wrong-path")).toThrow(
      "/telegram/webhook",
    );
  });

  it("generates a 256-bit hexadecimal webhook secret", () => {
    expect(generateWebhookSecret()).toMatch(/^[0-9a-f]{64}$/u);
  });
});
