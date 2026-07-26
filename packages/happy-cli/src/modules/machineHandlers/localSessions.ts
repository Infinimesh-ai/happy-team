/**
 * Discovers agent conversations stored on the local machine by Claude Code
 * (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`) and Codex
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`).
 *
 * Backs the machine-level RPCs that let the app offer "resume an existing
 * conversation" when creating a new Happy session. Scanning is bounded:
 * only the most recently modified files are parsed, and only the head of
 * each file is read — enough to recover the working directory and the
 * first real user prompt for display. The returned id feeds straight into
 * `spawn-happy-session` as `resumeClaudeSessionId` / `resumeCodexThreadId`.
 */

import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LocalSessionSummary {
    /** Claude session UUID or Codex thread id — feed to the matching resume option on spawn. */
    id: string;
    /** Working directory the conversation ran in. */
    directory: string;
    /** First user prompt, collapsed to a single line and truncated. */
    summary: string;
    /** Session file mtime, epoch ms. */
    updatedAt: number;
}

const DEFAULT_LIMIT = 60;
const HEAD_BYTES = 256 * 1024;
const SUMMARY_MAX_CHARS = 200;
const CODEX_WALK_MAX_DEPTH = 4; // sessions/YYYY/MM/DD

export function defaultClaudeProjectsDir(): string {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects');
}

export function defaultCodexSessionsDir(): string {
    const codexHome = process.env.CODEX_HOME
        ? process.env.CODEX_HOME.replace(/^~(?=$|\/|\\)/, homedir())
        : join(homedir(), '.codex');
    return join(codexHome, 'sessions');
}

/**
 * Read up to `maxBytes` from the start of the file and split into complete
 * lines. The trailing line is dropped when the read was truncated mid-line.
 */
async function readHeadLines(path: string, maxBytes: number): Promise<string[]> {
    const handle = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
        if (bytesRead === maxBytes) {
            lines.pop();
        }
        return lines.filter((line) => line.trim().length > 0);
    } finally {
        await handle.close();
    }
}

function toSingleLineSummary(text: string): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > SUMMARY_MAX_CHARS ? collapsed.slice(0, SUMMARY_MAX_CHARS - 1) + '…' : collapsed;
}

function parseJsonLine(line: string): any | null {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

interface SessionFileCandidate {
    path: string;
    id: string;
    mtime: number;
}

/**
 * Parse the head of a Claude Code JSONL: working directory comes from the
 * first line carrying `cwd`; the summary is the first user-typed prompt
 * (non-sidechain, string content), preferring one that is not a slash
 * command transcript (`<command-name>…`) or the local-command caveat.
 */
async function parseClaudeHead(path: string): Promise<{ directory: string; summary: string } | null> {
    const lines = await readHeadLines(path, HEAD_BYTES);
    let directory: string | null = null;
    let fallbackPrompt: string | null = null;

    for (const line of lines) {
        const parsed = parseJsonLine(line);
        if (!parsed) continue;

        if (!directory && typeof parsed.cwd === 'string' && parsed.cwd.length > 0) {
            directory = parsed.cwd;
        }

        if (parsed.type === 'user' && !parsed.isSidechain && typeof parsed.message?.content === 'string') {
            const text = parsed.message.content as string;
            const isMeta = text.startsWith('<') || text.startsWith('Caveat:');
            if (!isMeta && directory) {
                return { directory, summary: toSingleLineSummary(text) };
            }
            if (!fallbackPrompt) {
                fallbackPrompt = text;
            }
        }
    }

    if (directory && fallbackPrompt) {
        return { directory, summary: toSingleLineSummary(fallbackPrompt) };
    }
    return null;
}

/**
 * Parse the head of a Codex rollout JSONL: the first line is `session_meta`
 * (thread id + cwd); the summary is the first `event_msg` of type
 * `user_message`.
 */
async function parseCodexHead(path: string): Promise<{ id: string; directory: string; summary: string } | null> {
    const lines = await readHeadLines(path, HEAD_BYTES);
    if (lines.length === 0) return null;

    const meta = parseJsonLine(lines[0]);
    if (meta?.type !== 'session_meta') return null;
    const id = typeof meta.payload?.id === 'string' ? meta.payload.id
        : typeof meta.payload?.session_id === 'string' ? meta.payload.session_id : null;
    const directory = typeof meta.payload?.cwd === 'string' ? meta.payload.cwd : null;
    if (!id || !directory) return null;

    for (const line of lines) {
        const parsed = parseJsonLine(line);
        if (parsed?.type === 'event_msg' && parsed.payload?.type === 'user_message' && typeof parsed.payload.message === 'string') {
            return { id, directory, summary: toSingleLineSummary(parsed.payload.message) };
        }
    }
    // A rollout with no user message yet has nothing worth resuming
    return null;
}

async function statCandidate(path: string, id: string): Promise<SessionFileCandidate | null> {
    try {
        const stats = await stat(path);
        return stats.isFile() ? { path, id, mtime: stats.mtime.getTime() } : null;
    } catch {
        return null; // raced deletion
    }
}

/**
 * List local Claude Code sessions, most recently modified first.
 */
export async function listClaudeLocalSessions(projectsDir?: string, limit: number = DEFAULT_LIMIT): Promise<LocalSessionSummary[]> {
    const root = projectsDir ?? defaultClaudeProjectsDir();

    let projectDirs: string[];
    try {
        projectDirs = await readdir(root);
    } catch {
        return [];
    }

    const candidates: SessionFileCandidate[] = [];
    for (const dir of projectDirs) {
        let files: string[];
        try {
            files = await readdir(join(root, dir));
        } catch {
            continue;
        }
        const stated = await Promise.all(files
            .filter((file) => file.endsWith('.jsonl'))
            .map((file) => statCandidate(join(root, dir, file), file.slice(0, -'.jsonl'.length))));
        for (const candidate of stated) {
            if (candidate) candidates.push(candidate);
        }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);

    const sessions: LocalSessionSummary[] = [];
    for (const candidate of candidates) {
        if (sessions.length >= limit) break;
        try {
            const parsed = await parseClaudeHead(candidate.path);
            if (parsed) {
                sessions.push({ id: candidate.id, updatedAt: candidate.mtime, ...parsed });
            }
        } catch {
            // Unreadable file — skip it rather than failing the whole listing
        }
    }
    return sessions;
}

/**
 * List local Codex threads, most recently modified first.
 */
export async function listCodexLocalSessions(sessionsDir?: string, limit: number = DEFAULT_LIMIT): Promise<LocalSessionSummary[]> {
    const root = sessionsDir ?? defaultCodexSessionsDir();

    const candidates: SessionFileCandidate[] = [];
    async function walk(dir: string, depth: number): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth < CODEX_WALK_MAX_DEPTH) {
                    await walk(path, depth + 1);
                }
            } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
                const candidate = await statCandidate(path, entry.name);
                if (candidate) candidates.push(candidate);
            }
        }
    }
    await walk(root, 1);
    candidates.sort((a, b) => b.mtime - a.mtime);

    const sessions: LocalSessionSummary[] = [];
    for (const candidate of candidates) {
        if (sessions.length >= limit) break;
        try {
            const parsed = await parseCodexHead(candidate.path);
            if (parsed) {
                sessions.push({ updatedAt: candidate.mtime, ...parsed });
            }
        } catch {
            // Unreadable file — skip it rather than failing the whole listing
        }
    }
    return sessions;
}
