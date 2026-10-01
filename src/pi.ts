import type {
  AgentBeforeSettleEvent,
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type PiOutcome = "completed" | "aborted" | "error";

export interface PiAnswer {
  text: string;
}

export class PiExecutionError extends Error {
  public constructor() {
    super("Pi execution failed");
    this.name = "PiExecutionError";
  }
}

export class PiBridgeClosedError extends Error {
  public constructor() {
    super("Pi bridge is closed");
    this.name = "PiBridgeClosedError";
  }
}

interface AssistantLikeMessage {
  role?: unknown;
  content?: unknown;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block): block is { type: "text"; text: string } => {
      if (!block || typeof block !== "object") {
        return false;
      }
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((block) => block.text)
    .join("");
}

/** Extract only text blocks from the last assistant message. */
export function extractFinalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const assistant = message as AssistantLikeMessage;
    if (assistant.role === "assistant") {
      return textFromContent(assistant.content);
    }
  }
  return "";
}

interface ActiveRun {
  completion: Promise<PiAnswer>;
  resolve: (answer: PiAnswer) => void;
  reject: (reason?: unknown) => void;
  messages: readonly unknown[];
  outcome: PiOutcome | undefined;
}

export interface PiBridgeOptions {
  sleep?: (milliseconds: number) => Promise<void>;
}

export class PiAgentBridge {
  private context: ExtensionContext | undefined;
  private active: ActiveRun | undefined;
  private preparing = false;
  private closed = true;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  public constructor(
    private readonly sendUserMessage: (prompt: string) => void,
    options: PiBridgeOptions = {},
  ) {
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  public start(context: ExtensionContext): void {
    this.context = context;
    this.closed = false;
  }

  public stop(): void {
    this.closed = true;
    this.context = undefined;
    const active = this.active;
    this.active = undefined;
    active?.reject(new PiBridgeClosedError());
  }

  public async run(prompt: string): Promise<PiAnswer> {
    if (this.closed) {
      throw new PiBridgeClosedError();
    }
    if (this.active !== undefined || this.preparing) {
      throw new PiExecutionError();
    }

    this.preparing = true;
    try {
      await this.waitUntilIdle();
      if (this.closed) {
        throw new PiBridgeClosedError();
      }
    } finally {
      this.preparing = false;
    }

    let resolveCompletion!: (answer: PiAnswer) => void;
    let rejectCompletion!: (reason?: unknown) => void;
    const completion = new Promise<PiAnswer>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const active: ActiveRun = {
      completion,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      messages: [],
      outcome: undefined,
    };
    this.active = active;

    try {
      this.sendUserMessage(prompt);
    } catch {
      if (this.active === active) {
        this.active = undefined;
      }
      throw this.closed ? new PiBridgeClosedError() : new PiExecutionError();
    }

    return active.completion;
  }

  public handleAgentEnd(event: AgentEndEvent): void {
    if (this.active !== undefined) {
      this.active.messages = event.messages;
    }
  }

  public handleAgentBeforeSettle(event: AgentBeforeSettleEvent): void {
    if (this.active !== undefined) {
      this.active.outcome = event.outcome;
    }
  }

  public handleAgentSettled(): void {
    const active = this.active;
    if (active === undefined) {
      return;
    }
    this.active = undefined;

    if (active.outcome !== "completed") {
      active.reject(new PiExecutionError());
      return;
    }

    const text = extractFinalAssistantText(active.messages);
    if (!text.trim()) {
      active.reject(new PiExecutionError());
      return;
    }
    active.resolve({ text });
  }

  private async waitUntilIdle(): Promise<void> {
    while (this.context !== undefined && !this.context.isIdle()) {
      if (this.closed) {
        throw new PiBridgeClosedError();
      }
      await this.sleep(25);
    }
  }
}

export function createPiBridge(pi: ExtensionAPI, options: PiBridgeOptions = {}): PiAgentBridge {
  const bridge = new PiAgentBridge((prompt) => pi.sendUserMessage(prompt), options);
  pi.on("agent_end", (event) => {
    bridge.handleAgentEnd(event);
  });
  pi.on("agent_before_settle", (event) => {
    bridge.handleAgentBeforeSettle(event);
  });
  pi.on("agent_settled", () => {
    bridge.handleAgentSettled();
  });
  return bridge;
}
