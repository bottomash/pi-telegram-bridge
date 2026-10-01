export type QueueTask<T> = () => Promise<T> | T;

interface PendingTask<T> {
  task: QueueTask<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export class QueueClosedError extends Error {
  public constructor() {
    super("queue is closed");
    this.name = "QueueClosedError";
  }
}

/** A small single-worker FIFO queue. Tasks are never run concurrently. */
export class FifoQueue<T> {
  private readonly pending: PendingTask<T>[] = [];
  private running = false;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  public enqueue(task: QueueTask<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new QueueClosedError());
    }

    const result = new Promise<T>((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
    });
    void this.pump();
    return result;
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new QueueClosedError();
    while (this.pending.length > 0) {
      this.pending.shift()?.reject(error);
    }
    this.notifyIdleIfNeeded();
  }

  public get pendingCount(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public async waitForIdle(): Promise<void> {
    if (!this.running && this.pending.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    while (this.pending.length > 0) {
      const current = this.pending.shift();
      if (!current) {
        break;
      }
      try {
        current.resolve(await current.task());
      } catch (error) {
        current.reject(error);
      }
    }
    this.running = false;
    this.notifyIdleIfNeeded();
  }

  private notifyIdleIfNeeded(): void {
    if (this.running || this.pending.length > 0) {
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
