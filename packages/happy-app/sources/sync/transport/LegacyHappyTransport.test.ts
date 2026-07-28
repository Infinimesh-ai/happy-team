import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSocket } = vi.hoisted(() => {
    const messageHandlers = new Map<string, (data: any) => void>();
    return {
        mockSocket: {
            messageHandlers,
            initialize: vi.fn(),
            connect: vi.fn(),
            disconnect: vi.fn(),
            request: vi.fn(),
            sendAppState: vi.fn(),
            emitWithAck: vi.fn(),
            send: vi.fn(),
            updateToken: vi.fn(),
            onReconnected: vi.fn(() => () => {}),
            onStatusChange: vi.fn((listener: (s: string) => void) => {
                listener('disconnected');
                return () => {};
            }),
            onMessage: vi.fn((event: string, handler: (data: any) => void) => {
                messageHandlers.set(event, handler);
                return () => messageHandlers.delete(event);
            }),
            sessionRPC: vi.fn(),
            machineRPC: vi.fn(),
        },
    };
});

vi.mock('@/sync/apiSocket', () => ({ apiSocket: mockSocket }));

import { LegacyHappyTransport } from './LegacyHappyTransport';

function createTransport(): LegacyHappyTransport {
    return new LegacyHappyTransport({ endpoint: 'https://example.test', token: 't' }, {} as any);
}

describe('LegacyHappyTransport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSocket.messageHandlers.clear();
    });

    it('initializes apiSocket with the given config on construction', () => {
        createTransport();
        expect(mockSocket.initialize).toHaveBeenCalledWith(
            { endpoint: 'https://example.test', token: 't' },
            expect.anything(),
        );
    });

    it('routes session.rpc and machine.rpc requests to the socket RPC methods', async () => {
        mockSocket.sessionRPC.mockResolvedValue({ ok: 1 });
        mockSocket.machineRPC.mockResolvedValue({ ok: 2 });
        const transport = createTransport();

        await expect(
            transport.request({ id: 'r1', method: 'session.rpc', params: { sessionId: 's1', method: 'abort', params: {} } }),
        ).resolves.toEqual({ ok: 1 });
        expect(mockSocket.sessionRPC).toHaveBeenCalledWith('s1', 'abort', {});

        await expect(
            transport.request({ id: 'r2', method: 'machine.rpc', params: { machineId: 'm1', method: 'bash', params: { cmd: 'ls' } } }),
        ).resolves.toEqual({ ok: 2 });
        expect(mockSocket.machineRPC).toHaveBeenCalledWith('m1', 'bash', { cmd: 'ls' });
    });

    it('rejects unknown wire methods with an unsupported error', async () => {
        const transport = createTransport();
        await expect(
            transport.request({ id: 'r3', method: 'messages.pull', params: {} }),
        ).rejects.toMatchObject({ code: 'unsupported' });
    });

    it('bridges update/ephemeral payloads through events() in strict arrival order', async () => {
        const transport = createTransport();
        const received: Array<{ type: string; body: unknown }> = [];
        const consumer = (async () => {
            for await (const event of transport.events()) {
                received.push({ type: event.type, body: (event as any).body });
                if (received.length === 4) {
                    break;
                }
            }
        })();

        const updateHandler = mockSocket.messageHandlers.get('update')!;
        const ephemeralHandler = mockSocket.messageHandlers.get('ephemeral')!;
        updateHandler({ seq: 1 });
        ephemeralHandler({ activity: 'a' });
        updateHandler({ seq: 2 });
        updateHandler({ seq: 3 });
        await consumer;

        expect(received).toEqual([
            { type: 'legacy-update', body: { seq: 1 } },
            { type: 'legacy-ephemeral', body: { activity: 'a' } },
            { type: 'legacy-update', body: { seq: 2 } },
            { type: 'legacy-update', body: { seq: 3 } },
        ]);
    });

    it('unregisters socket handlers and ends the stream on close()', async () => {
        const transport = createTransport();
        void transport.events();
        expect(mockSocket.messageHandlers.size).toBe(2);
        await transport.close();
        expect(mockSocket.messageHandlers.size).toBe(0);
        expect(mockSocket.disconnect).toHaveBeenCalled();
    });
});
