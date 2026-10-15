import { describe, expect, it } from "vitest";

import { windowsTaskName } from "../src/windows-autostart.js";

describe("Windows autostart", () => {
  it("uses a stable per-profile scheduled task name", () => {
    expect(windowsTaskName("beancount")).toBe("Pi Telegram Bridge - beancount");
  });

  it("rejects unsafe profile names before constructing a task name", () => {
    expect(() => windowsTaskName("../other-task")).toThrow("只能包含");
  });
});
