import type { BridgeLogger } from "./config.js";
import { telegramUpdateToJob } from "./server.js";
import {
  TelegramTransport,
  TelegramTransportClosedError,
  type TelegramJob,
} from "./telegram.js";

const LONG_POLL_TIMEOUT_SECONDS = 30;
const POLLING_RETRY_DELAY_MS = 1000;

export interface LongPollingReceiverOptions {
  transport: TelegramTransport;
  allowedChatId: string;
  onMessage: (job: TelegramJob) => void | Promise<void>;
  logger: BridgeLogger;
}

function waitForRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, POLLING_RETRY_DELAY_MS);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Receives Telegram updates with getUpdates after ensuring no webhook remains active. */
export class LongPollingReceiver {
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;

  public constructor(private readonly options: LongPollingReceiverOptions) {}

  public async start(): Promise<void> {
    if (this.running !== undefined) {
      return;
    }
    await this.options.transport.deleteWebhook();
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.poll(controller.signal);
  }

  public async stop(): Promise<void> {
    const running = this.running;
    if (running === undefined) {
      return;
    }
    this.controller?.abort();
    await running;
    this.controller = undefined;
    this.running = undefined;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let offset: number | undefined;
    while (!signal.aborted) {
      let updates;
      try {
        updates = await this.options.transport.getUpdates(
          offset,
          LONG_POLL_TIMEOUT_SECONDS,
          signal,
        );
      } catch (error) {
        if (signal.aborted || error instanceof TelegramTransportClosedError) {
          return;
        }
        this.options.logger.warn("[telegram] long polling request failed; retrying");
        await waitForRetry(signal);
        continue;
      }

      for (const update of updates) {
        offset = Math.max(offset ?? 0, update.update_id + 1);
        const job = telegramUpdateToJob(update, this.options.allowedChatId);
        if (job === undefined) {
          continue;
        }
        this.options.logger.info(`[telegram] message received update_id=${job.updateId}`);
        try {
          void Promise.resolve(this.options.onMessage(job)).catch(() => {
            this.options.logger.error("[telegram] failed to enqueue message");
          });
        } catch {
          this.options.logger.error("[telegram] failed to enqueue message");
        }
      }
    }
  }
}
