export class UpdateDedupe {
  private readonly seen = new Set<number>();
  private readonly order: number[] = [];

  public constructor(private readonly capacity = 1000) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("dedupe capacity must be a positive integer");
    }
  }

  /** Returns true only for the first observation of an update ID. */
  public checkAndRemember(updateId: number): boolean {
    if (this.seen.has(updateId)) {
      return false;
    }

    this.seen.add(updateId);
    this.order.push(updateId);
    while (this.order.length > this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    return true;
  }

  public get size(): number {
    return this.order.length;
  }

  public clear(): void {
    this.seen.clear();
    this.order.length = 0;
  }
}
