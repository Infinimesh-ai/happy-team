/**
 * Push-to-pull bridge: callback-style producers (socket handlers) push items,
 * a single async-iterator consumer pulls them. Strictly FIFO, unbounded queue,
 * never drops. Sync's gap detection depends on `incomingSeq === lastSeq + 1`,
 * so preserving arrival order exactly is a correctness requirement here.
 *
 * Single-consumer by design: creating a second iterator over the same instance
 * throws instead of silently splitting the stream.
 */
export class AsyncPushIterable<T> implements AsyncIterable<T> {
    private queue: T[] = [];
    private waiter: ((result: IteratorResult<T>) => void) | null = null;
    private ended = false;
    private consumed = false;

    push(item: T): void {
        if (this.ended) {
            return;
        }
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter({ value: item, done: false });
        } else {
            this.queue.push(item);
        }
    }

    end(): void {
        if (this.ended) {
            return;
        }
        this.ended = true;
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter({ value: undefined, done: true });
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        if (this.consumed) {
            throw new Error('AsyncPushIterable supports a single consumer');
        }
        this.consumed = true;
        return {
            next: (): Promise<IteratorResult<T>> => {
                if (this.queue.length > 0) {
                    return Promise.resolve({ value: this.queue.shift()!, done: false });
                }
                if (this.ended) {
                    return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise((resolve) => {
                    this.waiter = resolve;
                });
            },
            return: (): Promise<IteratorResult<T>> => {
                this.end();
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    }
}
