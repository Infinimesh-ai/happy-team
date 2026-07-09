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
    shouldReconnect: mockShouldReconnect
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
