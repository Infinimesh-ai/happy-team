/**
 * task-prepare-worktree tests against real local git repositories (no mocks).
 * A bare repo stands in for `origin`; a working clone is the member checkout.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareTaskWorktree, TASK_ARTIFACT_DIR } from './prepareWorktree';
import { currentBranch, listWorktreePaths } from './taskGit';

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): void {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

/** Create a bare `origin` with one commit on `main`, plus a working clone. */
async function makeRepo(): Promise<{ repoPath: string; worktreesDir: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'happy-task-git-'));
    tempDirs.push(root);
    const originPath = path.join(root, 'origin.git');
    const seedPath = path.join(root, 'seed');
    const repoPath = path.join(root, 'clone');
    const worktreesDir = path.join(root, 'worktrees');

    execFileSync('git', ['init', '--bare', '-b', 'main', originPath], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', seedPath], { stdio: 'pipe' });
    git(seedPath, 'config', 'user.email', 'test@example.com');
    git(seedPath, 'config', 'user.name', 'Test');
    await writeFile(path.join(seedPath, 'README.md'), '# seed\n');
    git(seedPath, 'add', '.');
    git(seedPath, 'commit', '-m', 'init');
    git(seedPath, 'remote', 'add', 'origin', originPath);
    git(seedPath, 'push', 'origin', 'main');

    execFileSync('git', ['clone', originPath, repoPath], { stdio: 'pipe' });
    git(repoPath, 'config', 'user.email', 'test@example.com');
    git(repoPath, 'config', 'user.name', 'Test');
    return { repoPath, worktreesDir };
}

describe('prepareTaskWorktree', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        tempDirs.length = 0;
    });

    it('creates a worktree on a happy/ branch off origin/base with the artifact dir', async () => {
        const { repoPath, worktreesDir } = await makeRepo();
        const result = await prepareTaskWorktree(
            { taskId: 'task1', repoPath, baseBranch: 'main', workBranch: 'happy/alice/add-widget' },
            { worktreesDir },
        );

        expect(result.worktreePath).toBe(path.join(worktreesDir, 'task1'));
        expect(result.baseBranch).toBe('main');
        expect(result.skillsCommit).toBeNull();
        expect(existsSync(result.worktreePath)).toBe(true);
        expect(existsSync(path.join(result.worktreePath, TASK_ARTIFACT_DIR))).toBe(true);
        expect(await currentBranch(result.worktreePath)).toBe('happy/alice/add-widget');
        expect(await listWorktreePaths(repoPath)).toContain(result.worktreePath);
    });

    it('rejects a work branch without the happy/ prefix', async () => {
        const { repoPath, worktreesDir } = await makeRepo();
        await expect(
            prepareTaskWorktree(
                { taskId: 'task2', repoPath, baseBranch: 'main', workBranch: 'feature/x' },
                { worktreesDir },
            ),
        ).rejects.toThrow(/must start with "happy\//);
    });

    it('rejects a non-git repoPath', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'happy-task-nongit-'));
        tempDirs.push(root);
        await expect(
            prepareTaskWorktree(
                { taskId: 'task3', repoPath: root, baseBranch: 'main', workBranch: 'happy/a/b' },
                { worktreesDir: path.join(root, 'wt') },
            ),
        ).rejects.toThrow(/not a git repository/);
    });

    it('is idempotent: a second prepare reuses the existing worktree', async () => {
        const { repoPath, worktreesDir } = await makeRepo();
        const params = { taskId: 'task4', repoPath, baseBranch: 'main', workBranch: 'happy/bob/thing' };
        const first = await prepareTaskWorktree(params, { worktreesDir });
        const second = await prepareTaskWorktree(params, { worktreesDir });
        expect(second.worktreePath).toBe(first.worktreePath);
        // still exactly one task worktree registered
        const taskWorktrees = (await listWorktreePaths(repoPath)).filter((p) => p.startsWith(worktreesDir));
        expect(taskWorktrees).toEqual([first.worktreePath]);
    });

    it('supports two parallel tasks on isolated worktrees and branches', async () => {
        const { repoPath, worktreesDir } = await makeRepo();
        const a = await prepareTaskWorktree(
            { taskId: 'p-a', repoPath, baseBranch: 'main', workBranch: 'happy/a/one' },
            { worktreesDir },
        );
        const b = await prepareTaskWorktree(
            { taskId: 'p-b', repoPath, baseBranch: 'main', workBranch: 'happy/b/two' },
            { worktreesDir },
        );
        expect(a.worktreePath).not.toBe(b.worktreePath);
        expect(await currentBranch(a.worktreePath)).toBe('happy/a/one');
        expect(await currentBranch(b.worktreePath)).toBe('happy/b/two');
    });
});
