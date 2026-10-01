import type {
  AgentBeforeSettleEvent,
  AgentEndEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { extractFinalAssistantText, PiAgentBridge, PiExecutionError } from "../src/pi.js";

const idleContext = { isIdle: () => true } as ExtensionContext;

describe("PiAgentBridge", () => {
  it("waits for agent_settled and exposes only the final assistant text blocks", async () => {
    const sendUserMessage = vi.fn();
    const bridge = new PiAgentBridge(sendUserMessage);
    bridge.start(idleContext);

    const answer = bridge.run("prompt");
    await Promise.resolve();
    expect(sendUserMessage).toHaveBeenCalledWith("prompt");

    bridge.handleAgentEnd({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "intermediate" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret reasoning" },
            { type: "text", text: "final " },
            { type: "toolCall", id: "1", name: "x", arguments: {} },
            { type: "text", text: "answer" },
          ],
        },
      ],
    } as unknown as AgentEndEvent);
    bridge.handleAgentBeforeSettle({
      type: "agent_before_settle",
      outcome: "completed",
    } as unknown as AgentBeforeSettleEvent);

    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    bridge.handleAgentSettled();
    await expect(answer).resolves.toEqual({ text: "final answer" });
  });

  it("rejects an errored Pi run even if a partial assistant message exists", async () => {
    const bridge = new PiAgentBridge(() => undefined);
    bridge.start(idleContext);
    const answer = bridge.run("prompt");
    await Promise.resolve();
    bridge.handleAgentEnd({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }] }],
    } as unknown as AgentEndEvent);
    bridge.handleAgentBeforeSettle({
      type: "agent_before_settle",
      outcome: "error",
    } as unknown as AgentBeforeSettleEvent);
    bridge.handleAgentSettled();

    await expect(answer).rejects.toBeInstanceOf(PiExecutionError);
  });

  it("does not claim lifecycle events from an already-running local Pi task", async () => {
    let idle = false;
    let releasePoll!: () => void;
    const poll = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const sendUserMessage = vi.fn();
    const bridge = new PiAgentBridge(sendUserMessage, { sleep: () => poll });
    bridge.start({ isIdle: () => idle } as ExtensionContext);

    const answer = bridge.run("telegram prompt");
    bridge.handleAgentEnd({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "local answer" }] }],
    } as unknown as AgentEndEvent);
    bridge.handleAgentBeforeSettle({
      type: "agent_before_settle",
      outcome: "completed",
    } as unknown as AgentBeforeSettleEvent);
    bridge.handleAgentSettled();

    idle = true;
    releasePoll();
    await Promise.resolve();
    await Promise.resolve();
    expect(sendUserMessage).toHaveBeenCalledWith("telegram prompt");

    bridge.handleAgentEnd({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "telegram answer" }] }],
    } as unknown as AgentEndEvent);
    bridge.handleAgentBeforeSettle({
      type: "agent_before_settle",
      outcome: "completed",
    } as unknown as AgentBeforeSettleEvent);
    bridge.handleAgentSettled();
    await expect(answer).resolves.toEqual({ text: "telegram answer" });
  });

  it("extracts text only from the last assistant message", () => {
    expect(extractFinalAssistantText([
      { role: "assistant", content: [{ type: "text", text: "old" }] },
      { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "new" }] },
    ])).toBe("new");
  });
});
