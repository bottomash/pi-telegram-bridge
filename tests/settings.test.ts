import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  generateWebhookSecret,
  getAutostartProfile,
  getProfileAutostartDirectories,
  listProfiles,
  loadEffectiveConfig,
  normalizeWorkingDirectory,
  profileConfigPath,
  readSavedConfig,
  saveConfig,
  setAutostartProfile,
  setProfileAutostartDirectory,
  validateProfileName,
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
      mode: "webhook",
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
      mode: "webhook",
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
      mode: "webhook",
      botToken: "environment-token",
      allowedChatId: "222",
      webhookSecret: "environment-secret",
      host: "localhost",
      port: 9000,
    });
  });

  it("keeps named profiles separate and does not apply default environment overrides", async () => {
    const configPath = await temporaryConfigPath();
    const configDirectory = join(configPath, "..");
    const namedPath = profileConfigPath("beancount", configDirectory);
    await saveConfig({
      allowedChatId: "333",
      host: "127.0.0.1",
      port: 9999,
    }, namedPath);

    await expect(loadEffectiveConfig({
      env: {
        TELEGRAM_BOT_TOKEN: "default-environment-token",
        TELEGRAM_ALLOWED_CHAT_ID: "222",
        TELEGRAM_WEBHOOK_SECRET: "default-environment-secret",
      },
      configDirectory,
      profileName: "beancount",
      credentialStore: {
        load: async (profileName) => ({
          botToken: `${profileName}-token`,
          webhookSecret: `${profileName}-secret`,
        }),
        save: async () => undefined,
      },
    })).resolves.toEqual({
      mode: "webhook",
      botToken: "beancount-token",
      allowedChatId: "333",
      webhookSecret: "beancount-secret",
      host: "127.0.0.1",
      port: 9999,
    });
    await expect(listProfiles(configDirectory)).resolves.toEqual(["beancount"]);
  });

  it("loads polling mode from only its required environment variables", async () => {
    const configPath = await temporaryConfigPath();
    await expect(loadEffectiveConfig({
      env: {
        TELEGRAM_MODE: "polling",
        TELEGRAM_BOT_TOKEN: "polling-token",
        TELEGRAM_ALLOWED_CHAT_ID: "123456789",
      },
      configPath,
      credentialStore: {
        load: async () => { throw new Error("credential store should not be read"); },
        save: async () => undefined,
      },
    })).resolves.toEqual({
      mode: "polling",
      botToken: "polling-token",
      allowedChatId: "123456789",
    });
  });

  it("loads polling mode without requiring webhook-only settings or secrets", async () => {
    const configPath = await temporaryConfigPath();
    await saveConfig({
      mode: "polling",
      allowedChatId: "123456789",
    }, configPath);
    const pollingCredentials: CredentialStore = {
      load: async () => ({ botToken: "polling-token" }),
      save: async () => undefined,
    };

    await expect(loadEffectiveConfig({
      env: {},
      configPath,
      credentialStore: pollingCredentials,
    })).resolves.toEqual({
      mode: "polling",
      botToken: "polling-token",
      allowedChatId: "123456789",
    });
    await expect(readSavedConfig(configPath)).resolves.toEqual({
      mode: "polling",
      allowedChatId: "123456789",
    });
  });

  it("binds one Bot profile to a working directory for automatic startup", async () => {
    const configPath = await temporaryConfigPath();
    const autostartPath = join(configPath, "..", "autostart.json");
    const workingDirectory = join(configPath, "..", "project");

    await setAutostartProfile(workingDirectory, "beancount", autostartPath);
    await expect(getAutostartProfile(workingDirectory, autostartPath)).resolves.toBe("beancount");
    await setAutostartProfile(workingDirectory, undefined, autostartPath);
    await expect(getAutostartProfile(workingDirectory, autostartPath)).resolves.toBeUndefined();
  });

  it("replaces a profile's old directory binding during setup", async () => {
    const configPath = await temporaryConfigPath();
    const autostartPath = join(configPath, "..", "autostart.json");
    const oldDirectory = join(configPath, "..", "old-project");
    const newDirectory = join(configPath, "..", "new-project");

    await setAutostartProfile(oldDirectory, "beancount", autostartPath);
    await setProfileAutostartDirectory("beancount", newDirectory, autostartPath);
    await expect(getAutostartProfile(oldDirectory, autostartPath)).resolves.toBeUndefined();
    await expect(getAutostartProfile(newDirectory, autostartPath)).resolves.toBe("beancount");
    await expect(getProfileAutostartDirectories("beancount", autostartPath))
      .resolves.toEqual([normalizeWorkingDirectory(newDirectory)]);
  });

  it("validates Bot profile names", () => {
    expect(validateProfileName("beancount-bot_2")).toBe("beancount-bot_2");
    expect(() => validateProfileName("../../secret")).toThrow("只能包含");
  });

  it("rejects URL syntax in the local listening host", async () => {
    const configPath = await temporaryConfigPath();
    await expect(saveConfig({
      allowedChatId: "123456789",
      host: "http://localhost",
      port: 8787,
    }, configPath)).rejects.toThrow("hostname or IP address");
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
