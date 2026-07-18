/**
 * Machine-scoped RPC handlers served by the daemon connection. These back
 * the app's "new session" experience:
 *
 *   - `machine-list-directory`: read-only folder browsing confined to the
 *     user's home directory, so the app can offer a directory picker
 *     instead of a free-text path field. Deliberately narrower than the
 *     session-scoped file RPCs — no reads or writes, listing only.
 *   - `list-local-sessions`: surface conversations started outside Happy
 *     (plain `claude` / `codex` runs) so the app can resume them via
 *     `spawn-happy-session` with `resumeClaudeSessionId` /
 *     `resumeCodexThreadId`. Discovery is provider-based: each agent that
 *     knows how to enumerate its on-disk store registers a provider via
 *     `registerLocalSessionProvider`; agents without one return an empty
 *     list ("nothing to resume") rather than an error, so the app can ask
 *     for any agent uniformly.
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { logger } from '@/ui/logger';
import { listClaudeLocalSessions, listCodexLocalSessions, LocalSessionSummary } from './localSessions';

export interface MachineListDirectoryRequest {
    /** Absolute path to list; relative paths resolve against home. Defaults to home. */
    path?: string;
}

export interface MachineDirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    modified?: number; // epoch ms
    /** Present on directories: true when the folder contains a .git entry. */
    isGitRepo?: boolean;
}

export interface MachineListDirectoryResponse {
    success: boolean;
    /** Resolved absolute path that was listed. */
    path?: string;
    homeDir?: string;
    entries?: MachineDirectoryEntry[];
    error?: string;
}

export interface ListLocalSessionsRequest {
    /** Agent whose local conversation store to enumerate, e.g. 'claude'. */
    agent: string;
}

export interface ListLocalSessionsResponse {
    success: boolean;
    sessions?: LocalSessionSummary[];
    error?: string;
}

/** Enumerates an agent's on-disk conversations, most recent first. */
export type LocalSessionProvider = () => Promise<LocalSessionSummary[]>;

const localSessionProviders = new Map<string, LocalSessionProvider>([
    ['claude', () => listClaudeLocalSessions()],
    ['codex', () => listCodexLocalSessions()],
]);

/**
 * Register a discovery provider for an additional agent (e.g. an ACP agent
 * whose store location is only known to its integration module). Replaces
 * any existing provider for the same agent.
 */
export function registerLocalSessionProvider(agent: string, provider: LocalSessionProvider): void {
    localSessionProviders.set(agent, provider);
}

export function unregisterLocalSessionProvider(agent: string): void {
    localSessionProviders.delete(agent);
}

export function registerMachineHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<MachineListDirectoryRequest, MachineListDirectoryResponse>('machine-list-directory', async (data) => {
        const home = homedir();
        const requested = typeof data?.path === 'string' && data.path.trim().length > 0 ? data.path.trim() : home;
        const resolved = resolve(home, requested);

        if (resolved !== home && !resolved.startsWith(home + sep)) {
            return { success: false, error: `Access denied: path '${requested}' is outside the home directory` };
        }

        try {
            const dirents = await readdir(resolved, { withFileTypes: true });
            const entries = await Promise.all(dirents.map(async (entry): Promise<MachineDirectoryEntry> => {
                const type = entry.isDirectory() ? 'directory' as const : entry.isFile() ? 'file' as const : 'other' as const;
                const result: MachineDirectoryEntry = { name: entry.name, type };
                try {
                    const stats = await stat(join(resolved, entry.name));
                    result.modified = stats.mtime.getTime();
                } catch {
                    // Broken symlink or raced deletion — keep the bare entry
                }
                if (type === 'directory') {
                    // .git can be a directory or a file (worktrees); existence is enough
                    result.isGitRepo = await stat(join(resolved, entry.name, '.git')).then(() => true).catch(() => false);
                }
                return result;
            }));

            entries.sort((a, b) => {
                if (a.type === 'directory' && b.type !== 'directory') return -1;
                if (a.type !== 'directory' && b.type === 'directory') return 1;
                return a.name.localeCompare(b.name);
            });

            return { success: true, path: resolved, homeDir: home, entries };
        } catch (error) {
            logger.debug('[MACHINE HANDLERS] Failed to list directory:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' };
        }
    });

    rpcHandlerManager.registerHandler<ListLocalSessionsRequest, ListLocalSessionsResponse>('list-local-sessions', async (data) => {
        if (typeof data?.agent !== 'string' || data.agent.length === 0) {
            return { success: false, error: 'agent is required' };
        }
        const provider = localSessionProviders.get(data.agent);
        if (!provider) {
            // No discovery for this agent — nothing to resume, not an error
            return { success: true, sessions: [] };
        }
        try {
            return { success: true, sessions: await provider() };
        } catch (error) {
            logger.debug(`[MACHINE HANDLERS] Failed to list local ${data.agent} sessions:`, error);
            return { success: false, error: error instanceof Error ? error.message : `Failed to list local ${data.agent} sessions` };
        }
    });
}
