import { describe, expect, it } from 'vitest';
import { AsyncPushIterable } from './asyncPushIterable';

describe('AsyncPushIterable', () => {
    it('preserves strict FIFO order across buffered and awaited pushes', async () => {
        const stream = new AsyncPushIterable<number>();
        // Buffered before consumption starts
        stream.push(1);
        stream.push(2);

        const received: number[] = [];
        const consumer = (async () => {
            for await (const item of stream) {
                received.push(item);
                if (received.length === 5) {
                    break;
                }
            }
        })();

        // Pushed while the consumer is awaiting
        stream.push(3);
        await Promise.resolve();
        stream.push(4);
        stream.push(5);
        await consumer;

        expect(received).toEqual([1, 2, 3, 4, 5]);
    });

    it('does not drop items under burst pushes', async () => {
        const stream = new AsyncPushIterable<number>();
        const total = 1000;
        for (let i = 0; i < total; i++) {
            stream.push(i);
        }
        stream.end();

        const received: number[] = [];
        for await (const item of stream) {
            received.push(item);
        }
        expect(received).toHaveLength(total);
        expect(received[0]).toBe(0);
        expect(received[total - 1]).toBe(total - 1);
    });

    it('terminates the consumer on end() and ignores later pushes', async () => {
        const stream = new AsyncPushIterable<number>();
        const consumer = (async () => {
            const received: number[] = [];
            for await (const item of stream) {
                received.push(item);
            }
            return received;
        })();

        stream.push(1);
        await Promise.resolve();
        stream.end();
        stream.push(2);

        expect(await consumer).toEqual([1]);
    });

    it('rejects a second consumer', () => {
        const stream = new AsyncPushIterable<number>();
        stream[Symbol.asyncIterator]();
        expect(() => stream[Symbol.asyncIterator]()).toThrow('single consumer');
    });
});
