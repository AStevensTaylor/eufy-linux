export class RingBuffer<T> {
  private readonly items: T[] = [];
  readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  /** Newest first. */
  recent(limit?: number): T[] {
    const n = limit === undefined ? this.items.length : Math.max(0, Math.min(limit, this.items.length));
    return this.items.slice(this.items.length - n).reverse();
  }

  find(pred: (item: T) => boolean): T | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      if (pred(it)) return it;
    }
    return undefined;
  }

  get size(): number {
    return this.items.length;
  }
}
