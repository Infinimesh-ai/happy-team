import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiMachineClient, applyTeamAgentEnv } from './apiMachine';
import type { Machine } from './types';

const {
    mockIo,
    mockShouldReconnect
} = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockShouldReconnect: vi.fn(() => true)
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'http://127.0.0.1:3005',
        currentCliVersion: 'test'
    }
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/modules/common/registerCommonHandlers', () => ({
    registerCommonHandlers: vi.fn()
}));

vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn();
        unregisterHandler = vi.fn();
        hasHandler = vi.fn(() => false);
    }
}));

vi.mock('@/utils/detectCLI', () => ({
    detectCLIAvailability: vi.fn(() => ({
        claude: false,
        codex: false,
        gemini: false,
        openclaw: false
    }))
}));

vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(() => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false
    }))
}));

vi.mock('@/utils/lidState', () => ({
    shouldReconnect: mockShouldReconnect,
    retainReconnectCapabilityMonitor: vi.fn(),
    releaseReconnectCapabilityMonitor: vi.fn()
}));

type SocketHandler = (...args: any[]) => void;
type SocketHandlers = Record<string, SocketHandler[]>;

function makeMachine(): Machine {
    return {
        id: 'test-machine-id',
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy',
            happyLibDir: '/home/user/.happy/lib'
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy'
    };
}

describe('ApiMachineClient socket reconnection', () => {
    let socketHandlers: SocketHandlers;
    let mockSocket: any;

    const emitSocketEvent = (event: string, ...args: any[]) => {
        const handlers = socketHandlers[event] || [];
        handlers.forEach((handler) => handler(...args));
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockShouldReconnect.mockReturnValue(true);
        socketHandlers = {};
        mockSocket = {
            connected: false,
            connect: vi.fn(),
            on: vi.fn((event: string, handler: SocketHandler) => {
                if (!socketHandlers[event]) {
                    socketHandlers[event] = [];
                }
                socketHandlers[event].push(handler);
            }),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            close: vi.fn(),
            io: {
                on: vi.fn()
            }
        };

        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('retries after initial socket connection error', async () => {
        vi.useFakeTimers();

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockIo).toHaveBeenCalledWith('ws://127.0.0.1:3005', expect.objectContaining({
            reconnection: false
        }));
        expect(mockSocket.connect).not.toHaveBeenCalled();

        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(mockSocket.connect).toHaveBeenCalledTimes(2);

        client.shutdown();
    });

    it('rechecks reconnect eligibility before the delayed retry fires', async () => {
        vi.useFakeTimers();
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        mockShouldReconnect.mockReset();
        mockShouldReconnect.mockReturnValueOnce(true).mockReturnValue(false);
        emitSocketEvent('connect_error', new Error('ECONNREFUSED'));

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockSocket.connect).not.toHaveBeenCalled();

        client.shutdown();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mockSocket.connect).not.toHaveBeenCalled();
    });

    it('emits machine-alive immediately when the socket connects', async () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));

        const client = new ApiMachineClient('fake-token', makeMachine());
        client.connect();

        expect(mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive')).toHaveLength(0);

        emitSocketEvent('connect');

        let aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(1);
        expect(aliveCalls[0][1]).toEqual(expect.objectContaining({
            machineId: 'test-machine-id',
            time: expect.any(Number)
        }));

        await vi.advanceTimersByTimeAsync(19999);
        aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        aliveCalls = mockSocket.emit.mock.calls.filter(([event]: [string]) => event === 'machine-alive');
        expect(aliveCalls).toHaveLength(2);

        client.shutdown();
    });

    it('reports readiness only after both spawn and resume are acknowledged, and resets on disconnect', () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({ spawnSession: vi.fn(), resumeSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });
        client.connect();
        expect(client.isReady()).toBe(false);
        mockSocket.connected = true;
        emitSocketEvent('connect');
        emitSocketEvent('rpc-registered', { method: 'other:spawn-happy-session' });
        expect(client.isReady()).toBe(false);
        emitSocketEvent('rpc-registered', { method: 'test-machine-id:spawn-happy-session' });
        expect(client.isReady()).toBe(false);
        emitSocketEvent('rpc-registered', { method: 'test-machine-id:resume-happy-session' });
        expect(client.isReady()).toBe(true);
        emitSocketEvent('rpc-unregistered', { method: 'test-machine-id:resume-happy-session' });
        expect(client.isReady()).toBe(false);
        emitSocketEvent('rpc-registered', { method: 'test-machine-id:resume-happy-session' });
        emitSocketEvent('disconnect', 'transport close');
        expect(client.isReady()).toBe(false);
        emitSocketEvent('connect');
        expect(client.isReady()).toBe(false);
        client.shutdown();
    });

    it('does not require a resume acknowledgment when no resume handler exists', () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));
        const client = new ApiMachineClient('fake-token', makeMachine());
        client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });
        client.connect();
        mockSocket.connected = true;
        emitSocketEvent('connect');
        emitSocketEvent('rpc-registered', null);
        emitSocketEvent('rpc-registered', { method: 'test-machine-id:spawn-happy-session' });
        expect(client.isReady()).toBe(true);
        client.shutdown();
    });

    it('republishes the running CLI version without dropping stored machine fields', () => {
        vi.useFakeTimers();
        mockSocket.emitWithAck.mockImplementation(() => new Promise(() => {}));
        const machine = makeMachine();
        machine.metadata.happyCliVersion = '1.0.0';
        const storedMetadata = machine.metadata as Machine['metadata'] & { displayName?: string };
        storedMetadata.displayName = 'My Mac';
        const client = new ApiMachineClient('fake-token', machine);
        let publishedMetadata: (Machine['metadata'] & { displayName?: string }) | null = null;
        vi.spyOn(client, 'updateMachineMetadata').mockImplementation(async (handler) => {
            publishedMetadata = handler(storedMetadata);
        });
        client.connect();

        emitSocketEvent('connect');

        expect(publishedMetadata).toEqual(expect.objectContaining({
            displayName: 'My Mac',
            happyCliVersion: 'test',
            cliAvailability: expect.objectContaining({
                claude: false,
                codex: false,
            }),
        }));

        client.shutdown();
    });
});

describe('team agent env application', () => {
    const envKeys = [
        'HOME',
        'CLAUDE_CONFIG_DIR',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'OPENAI_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
    ] as const;
    let originalEnv: Partial<Record<typeof envKeys[number], string>>;
    let tempDirs: string[] = [];

    beforeEach(() => {
        originalEnv = {};
        for (const key of envKeys) {
            originalEnv[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(async () => {
        for (const key of envKeys) {
            const value = originalEnv[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        tempDirs = [];
    });

    it('loads Claude OAuth credentials when applying Personal OAuth mode through daemon RPC', async () => {
        const home = await mkdtemp(path.join(tmpdir(), 'happy-team-agent-env-'));
        tempDirs.push(home);
        process.env.HOME = home;
        process.env.ANTHROPIC_API_KEY = 'old-company-anthropic';
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'old-oauth-token';

        await mkdir(path.join(home, '.claude'), { recursive: true });
        await writeFile(path.join(home, '.claude', '.credentials.json'), JSON.stringify({
            claudeAiOauth: { accessToken: 'personal-oauth-token' },
        }));

        const result = await applyTeamAgentEnv({
            env: { OPENAI_API_KEY: 'team-openai-key' },
            clearKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY'],
            restart: false,
        }, () => {
            throw new Error('restart should not be requested');
        });

        expect(result.restartScheduled).toBe(false);
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('personal-oauth-token');
        expect(process.env.OPENAI_API_KEY).toBe('team-openai-key');

        const envFile = await readFile(path.join(home, '.happy-team', 'agent.env'), 'utf8');
        expect(envFile).toContain("OPENAI_API_KEY='team-openai-key'");
        expect(envFile).not.toContain('ANTHROPIC_API_KEY');
        expect(envFile).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
        expect(envFile).not.toContain('personal-oauth-token');
    });

    it('preserves env keys outside clearKeys when applying a partial update', async () => {
        const home = await mkdtemp(path.join(tmpdir(), 'happy-team-partial-env-'));
        tempDirs.push(home);
        process.env.HOME = home;

        await mkdir(path.join(home, '.happy-team'), { recursive: true });
        await writeFile(path.join(home, '.happy-team', 'agent.env'), [
            '# Managed by Happy Team Edition. Rewrite through the team UI.',
            "ANTHROPIC_API_KEY='existing-anthropic-key'",
            "OPENAI_API_KEY='existing-openai-key'",
            '',
        ].join('\n'));

        // Server updates only Claude (e.g. the Codex company key is not
        // configured server-side) — the Codex key must survive the rewrite.
        await applyTeamAgentEnv({
            env: { ANTHROPIC_API_KEY: 'new-anthropic-key' },
            clearKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
            restart: false,
        }, () => {
            throw new Error('restart should not be requested');
        });

        expect(process.env.ANTHROPIC_API_KEY).toBe('new-anthropic-key');
        expect(process.env.OPENAI_API_KEY).toBe('existing-openai-key');

        const envFile = await readFile(path.join(home, '.happy-team', 'agent.env'), 'utf8');
        expect(envFile).toContain("ANTHROPIC_API_KEY='new-anthropic-key'");
        expect(envFile).toContain("OPENAI_API_KEY='existing-openai-key'");
    });

    it('clears stale Claude OAuth tokens when applying Company API mode through daemon RPC', async () => {
        const home = await mkdtemp(path.join(tmpdir(), 'happy-team-company-env-'));
        tempDirs.push(home);
        process.env.HOME = home;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'stale-personal-oauth-token';
        await mkdir(path.join(home, '.claude'), { recursive: true });
        await writeFile(path.join(home, '.claude', '.credentials.json'), JSON.stringify({
            claudeAiOauth: { accessToken: 'personal-oauth-token' },
        }));

        await applyTeamAgentEnv({
            env: {
                ANTHROPIC_API_KEY: 'team-anthropic-key',
                OPENAI_API_KEY: 'team-openai-key',
            },
            clearKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY'],
            restart: false,
        }, () => {
            throw new Error('restart should not be requested');
        });

        expect(process.env.ANTHROPIC_API_KEY).toBe('team-anthropic-key');
        expect(process.env.OPENAI_API_KEY).toBe('team-openai-key');
        expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

        const envFile = await readFile(path.join(home, '.happy-team', 'agent.env'), 'utf8');
        expect(envFile).toContain("ANTHROPIC_API_KEY='team-anthropic-key'");
        expect(envFile).toContain("OPENAI_API_KEY='team-openai-key'");
        expect(envFile).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
        expect(envFile).not.toContain('personal-oauth-token');
    });
});
