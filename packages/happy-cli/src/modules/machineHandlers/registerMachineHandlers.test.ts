import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { encodeBase64, decodeBase64, encrypt, decrypt } from '@/api/encryption';
import { registerMachineHandlers, registerLocalSessionProvider, unregisterLocalSessionProvider } from './registerMachineHandlers';

describe('registerMachineHandlers', () => {
    let home: string;
    let manager: RpcHandlerManager;
    const key = new Uint8Array(32).fill(7);
    const savedHome = process.env.HOME;
    const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const savedCodexHome = process.env.CODEX_HOME;

    async function call<T>(method: string, params: unknown): Promise<T> {
        const response = await manager.handleRequest({
            method: `machine-test:${method}`,
            params: encodeBase64(encrypt(key, 'dataKey', params)),
        });
        return decrypt(key, 'dataKey', decodeBase64(response)) as T;
    }

    beforeEach(async () => {
        home = join(tmpdir(), `machine-handlers-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(home, { recursive: true });
        process.env.HOME = home;
        process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
        process.env.CODEX_HOME = join(home, '.codex');

        manager = new RpcHandlerManager({
            scopePrefix: 'machine-test',
            encryptionKey: key,
            encryptionVariant: 'dataKey',
            logger: () => { },
        });
        registerMachineHandlers(manager);
    });

    afterEach(async () => {
        process.env.HOME = savedHome;
        if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
        if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = savedCodexHome;
        if (existsSync(home)) {
            await rm(home, { recursive: true, force: true });
        }
    });

    describe('machine-list-directory', () => {
        it('lists the home directory by default, directories first, with git markers', async () => {
            await mkdir(join(home, 'repo', '.git'), { recursive: true });
            await mkdir(join(home, 'plain'), { recursive: true });
            await writeFile(join(home, 'file.txt'), 'x', 'utf-8');

            const result = await call<any>('machine-list-directory', {});
            expect(result.success).toBe(true);
            expect(result.path).toBe(home);
            expect(result.homeDir).toBe(home);
            expect(result.entries.map((e: any) => e.name)).toEqual(['plain', 'repo', 'file.txt']);
            expect(result.entries.find((e: any) => e.name === 'repo').isGitRepo).toBe(true);
            expect(result.entries.find((e: any) => e.name === 'plain').isGitRepo).toBe(false);
        });

        it('lists an absolute subpath within home', async () => {
            await mkdir(join(home, 'projects', 'app'), { recursive: true });

            const result = await call<any>('machine-list-directory', { path: join(home, 'projects') });
            expect(result.success).toBe(true);
            expect(result.entries.map((e: any) => e.name)).toEqual(['app']);
        });

        it('rejects paths outside the home directory', async () => {
            const result = await call<any>('machine-list-directory', { path: '/etc' });
            expect(result.success).toBe(false);
            expect(result.error).toContain('outside the home directory');
        });

        it('rejects traversal escaping home', async () => {
            const result = await call<any>('machine-list-directory', { path: join(home, '..') });
            expect(result.success).toBe(false);
            expect(result.error).toContain('outside the home directory');
        });

        it('fails gracefully for a missing directory', async () => {
            const result = await call<any>('machine-list-directory', { path: join(home, 'nope') });
            expect(result.success).toBe(false);
            expect(result.error).toBeTruthy();
        });
    });

    describe('list-local-sessions', () => {
        it('returns claude sessions from CLAUDE_CONFIG_DIR', async () => {
            const projectDir = join(home, '.claude', 'projects', '-home-user-app');
            await mkdir(projectDir, { recursive: true });
            const id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
            await writeFile(join(projectDir, `${id}.jsonl`), JSON.stringify({
                type: 'user', cwd: '/home/user/app', message: { role: 'user', content: 'hello there' },
            }) + '\n', 'utf-8');

            const result = await call<any>('list-local-sessions', { agent: 'claude' });
            expect(result.success).toBe(true);
            expect(result.sessions).toHaveLength(1);
            expect(result.sessions[0]).toMatchObject({ id, directory: '/home/user/app', summary: 'hello there' });
        });

        it('returns codex threads from CODEX_HOME', async () => {
            const day = join(home, '.codex', 'sessions', '2026', '07', '10');
            await mkdir(day, { recursive: true });
            const id = '019f4502-9e70-7733-8bfc-bb3e82d7bacb';
            const lines = [
                { type: 'session_meta', payload: { id, cwd: '/home/user/app' } },
                { type: 'event_msg', payload: { type: 'user_message', message: 'do the thing' } },
            ];
            await writeFile(join(day, `rollout-2026-07-10T00-00-00-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

            const result = await call<any>('list-local-sessions', { agent: 'codex' });
            expect(result.success).toBe(true);
            expect(result.sessions).toHaveLength(1);
            expect(result.sessions[0]).toMatchObject({ id, directory: '/home/user/app', summary: 'do the thing' });
        });

        it('returns empty lists when the stores do not exist', async () => {
            const claude = await call<any>('list-local-sessions', { agent: 'claude' });
            expect(claude).toEqual({ success: true, sessions: [] });
            const codex = await call<any>('list-local-sessions', { agent: 'codex' });
            expect(codex).toEqual({ success: true, sessions: [] });
        });

        it('returns an empty list for agents without a provider', async () => {
            const result = await call<any>('list-local-sessions', { agent: 'gemini' });
            expect(result).toEqual({ success: true, sessions: [] });
        });

        it('rejects a missing agent parameter', async () => {
            const result = await call<any>('list-local-sessions', {});
            expect(result.success).toBe(false);
            expect(result.error).toContain('agent is required');
        });

        it('uses providers registered at runtime', async () => {
            registerLocalSessionProvider('grok', async () => [
                { id: 'g-1', directory: '/home/user/app', summary: 'from grok', updatedAt: 123 },
            ]);
            try {
                const result = await call<any>('list-local-sessions', { agent: 'grok' });
                expect(result.success).toBe(true);
                expect(result.sessions).toEqual([
                    { id: 'g-1', directory: '/home/user/app', summary: 'from grok', updatedAt: 123 },
                ]);
            } finally {
                unregisterLocalSessionProvider('grok');
            }
        });
    });
});
