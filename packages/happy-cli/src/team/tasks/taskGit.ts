/**
 * Thin git runner for cloud-agent task daemon RPCs.
 *
 * Uses execFile (no shell) so repo paths, branch names and refs are passed as
 * argv and never interpreted by a shell. All task RPCs go through this helper
 * so git invocation, cwd handling and error surfacing stay in one place.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitResult {
    stdout: string;
    stderr: string;
}

/**
 * Run a git command in `cwd`. Rejects with a descriptive Error (including
 * stderr) on non-zero exit so callers can surface a useful RPC error.
 */
export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
    try {
        const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
            maxBuffer: 32 * 1024 * 1024,
        });
        return { stdout: stdout.toString(), stderr: stderr.toString() };
    } catch (error) {
        const err = error as { stderr?: string | Buffer; message?: string };
        const stderr = err.stderr ? err.stderr.toString().trim() : '';
        const detail = stderr || err.message || 'unknown git error';
        throw new Error(`git ${args.join(' ')} failed: ${detail}`);
    }
}

/** True when `cwd` is inside a git working tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
    try {
        const { stdout } = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
        return stdout.trim() === 'true';
    } catch {
        return false;
    }
}

/** Absolute worktree paths currently registered on the repo at `cwd`. */
export async function listWorktreePaths(cwd: string): Promise<string[]> {
    const { stdout } = await runGit(cwd, ['worktree', 'list', '--porcelain']);
    return stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length).trim());
}

/** Current branch name of the working tree at `cwd` (empty if detached). */
export async function currentBranch(cwd: string): Promise<string> {
    const { stdout } = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = stdout.trim();
    return branch === 'HEAD' ? '' : branch;
}
