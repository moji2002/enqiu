/**
 * A binary heap ordered by a caller-supplied comparator.
 *
 * The queue keeps two: one ordered by priority for ready work, one by run-at
 * for delayed work. Both need O(log n) push and pop on every pump.
 */

export class BinaryHeap<T> {
  private readonly values: T[] = [];

  constructor(private readonly before: (left: T, right: T) => boolean) {}

  peek(): T | undefined {
    return this.values[0];
  }

  push(value: T): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.before(value, this.values[parent] as T)) {
        break;
      }
      this.values[index] = this.values[parent] as T;
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): T | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (first === undefined || last === undefined || this.values.length === 0) {
      return first;
    }

    let index = 0;
    this.values[0] = last;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let next = index;
      if (
        left < this.values.length &&
        this.before(this.values[left] as T, this.values[next] as T)
      ) {
        next = left;
      }
      if (
        right < this.values.length &&
        this.before(this.values[right] as T, this.values[next] as T)
      ) {
        next = right;
      }
      if (next === index) {
        break;
      }
      [this.values[index], this.values[next]] = [
        this.values[next] as T,
        this.values[index] as T,
      ];
      index = next;
    }
    return first;
  }

  remove(value: T): void {
    const filtered = this.values.filter((entry) => entry !== value);
    if (filtered.length === this.values.length) {
      return;
    }
    this.values.length = 0;
    for (const entry of filtered) {
      this.push(entry);
    }
  }
}

