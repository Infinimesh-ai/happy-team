/**
 * `task-prepare-worktree` daemon RPC (plan §8, milestone C0.3).
 *
 * Given a target repo and a server-computed work branch, create an isolated git
 * worktree so a task's agent sessions run without disturbing the member's
 * checkout or other parallel tasks. Steps:
 *   1. fetch the base branch from origin
 *   2. `git worktree add <path> -b happy/<user>/<slug> origin/<base>`
 *   3. create the `.happy-task/` hand-off directory inside the worktree
 *
 * Team-Skills injection and machine-local config rebuild (plan §9) are deferred
 * to C3; {@link injectTeamSkills} is the mount point left in place here.
 */
import { existsSync } from 'fs';
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { currentBranch, isGitRepo, listWorktreePaths, runGit } from './taskGit';

/** Enforced prefix for task work branches (plan §1.3 branch convention). */
export const TASK_BRANCH_PREFIX = 'happy/';

/** Worktree-relative directory holding the file hand-off medium (plan §4). */
export const TASK_ARTIFACT_DIR = '.happy-task';

export interface PrepareWorktreeParams {
    taskId: string;
    repoPath: string;
    baseBranch: string;
    workBranch: string;
}

export interface PrepareWorktreeDeps {
    /** Base directory for task worktrees; defaults to `<happyHomeDir>/worktrees`. */
    worktreesDir?: string;
}

export interface PrepareWorktreeResult {
    worktreePath: string;
    workBranch: string;
    baseBranch: string;
    /** Team-Skills HEAD injected into the worktree; null until C3 wires it. */
    skillsCommit: string | null;
}

/** Resolve the base directory for task worktrees (`~/.happy/worktrees`). */
export function resolveWorktreesDir(deps?: PrepareWorktreeDeps): string {
    if (deps?.worktreesDir) return deps.worktreesDir;
    const home = configuration.happyHomeDir || path.join(homedir(), '.happy');
    return path.join(home, 'worktrees');
}

function requireNonEmpty(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

/**
 * Team-Skills injection mount point (plan §9). No-op until C3, which will sync
 * the machine-local skills clone into the worktree and record its HEAD. Kept as
 * a named seam so the prepare flow already threads a skillsCommit through.
 */
export async function injectTeamSkills(_worktreePath: string): Promise<{ skillsCommit: string | null }> {
    return { skillsCommit: null };
}

/**
 * Prepare an isolated worktree for a task. Idempotent: if the target worktree
 * path is already registered on the repo, it is returned as-is instead of being
 * recreated (a retried prepare must not fail or clobber in-flight work).
 */
export async function prepareTaskWorktree(
    params: PrepareWorktreeParams,
    deps?: PrepareWorktreeDeps,
): Promise<PrepareWorktreeResult> {
    const taskId = requireNonEmpty(params.taskId, 'taskId');
    const repoPath = requireNonEmpty(params.repoPath, 'repoPath');
    const baseBranch = requireNonEmpty(params.baseBranch, 'baseBranch');
    const workBranch = requireNonEmpty(params.workBranch, 'workBranch');

    if (!workBranch.startsWith(TASK_BRANCH_PREFIX)) {
        throw new Error(`workBranch must start with "${TASK_BRANCH_PREFIX}" (got "${workBranch}")`);
    }
    if (!existsSync(repoPath)) {
        throw new Error(`repoPath does not exist: ${repoPath}`);
    }
    if (!(await isGitRepo(repoPath))) {
        throw new Error(`repoPath is not a git repository: ${repoPath}`);
    }

    const worktreesDir = resolveWorktreesDir(deps);
    const worktreePath = path.join(worktreesDir, taskId);

    // Idempotency: an already-registered worktree at this path is reused.
    const existing = await listWorktreePaths(repoPath);
    if (existing.includes(worktreePath)) {
        logger.debug(`[TASK PREPARE] Reusing existing worktree ${worktreePath}`);
        await ensureArtifactDir(worktreePath);
        await writeTaskMcpConfig(worktreePath);
        const { skillsCommit } = await injectTeamSkills(worktreePath);
        return { worktreePath, workBranch: await currentBranch(worktreePath) || workBranch, baseBranch, skillsCommit };
    }
    if (existsSync(worktreePath)) {
        throw new Error(`worktree path already exists and is not a registered worktree: ${worktreePath}`);
    }

    await mkdir(worktreesDir, { recursive: true });

    // Fetch the base branch so origin/<base> is up to date before branching.
    await runGit(repoPath, ['fetch', 'origin', baseBranch]);
    await runGit(repoPath, ['worktree', 'add', worktreePath, '-b', workBranch, `origin/${baseBranch}`]);

    await ensureArtifactDir(worktreePath);
    await writeTaskMcpConfig(worktreePath);
    const { skillsCommit } = await injectTeamSkills(worktreePath);

    logger.debug(`[TASK PREPARE] Prepared worktree ${worktreePath} on branch ${workBranch}`);
    return { worktreePath, workBranch, baseBranch, skillsCommit };
}

async function ensureArtifactDir(worktreePath: string): Promise<void> {
    await mkdir(path.join(worktreePath, TASK_ARTIFACT_DIR), { recursive: true });
}

/** Machine-local `.mcp.json` filename registering the task-control MCP server. */
export const TASK_MCP_CONFIG = '.mcp.json';

/**
 * Register the task-control MCP server for the worktree's agent session by
 * writing a machine-local `.mcp.json` (plan §7). The file is git-excluded via
 * `.git/info/exclude` so it never lands in the delivered branch. The per-session
 * token/id flow in through the environment injected at spawn time, so the config
 * itself carries no secrets and is stable across stages.
 */
export async function writeTaskMcpConfig(worktreePath: string, happyCommand = 'happy'): Promise<void> {
    const configPath = path.join(worktreePath, TASK_MCP_CONFIG);
    const config = {
        mcpServers: {
            'happy-task': { command: happyCommand, args: ['task-mcp'] },
        },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await excludeLocally(worktreePath, TASK_MCP_CONFIG);
}

/** Add a path to the worktree's local `.git/info/exclude` (never committed). */
async function excludeLocally(worktreePath: string, entry: string): Promise<void> {
    try {
        const { stdout } = await runGit(worktreePath, ['rev-parse', '--git-path', 'info/exclude']);
        const excludePath = path.isAbsolute(stdout.trim()) ? stdout.trim() : path.join(worktreePath, stdout.trim());
        const existing = existsSync(excludePath) ? await readFile(excludePath, 'utf8') : '';
        if (!existing.split('\n').some((line) => line.trim() === entry)) {
            await appendFile(excludePath, `${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}${entry}\n`);
        }
    } catch (error) {
        logger.debug(`[TASK PREPARE] could not exclude ${entry}: ${error}`);
    }
}
