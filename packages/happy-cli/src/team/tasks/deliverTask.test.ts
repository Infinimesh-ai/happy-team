/**
 * task-deliver / task-cleanup tests. Git push runs for real against a local
 * bare origin; the external gh/glab PR creation is exercised through an
 * injected seam so orchestration is verified offline. Pure helpers
 * (platform detection, pr.md/plan.md parsing) are tested directly.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    cleanupTask,
    deliverTask,
    detectGitPlatform,
    extractRemoteHost,
    resolvePrContent,
    type CreatePullRequestInput,
} from './deliverTask';
import { prepareTaskWorktree, TASK_ARTIFACT_DIR } from './prepareWorktree';
import { listWorktreePaths } from './taskGit';

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): void {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

async function makeRepo(): Promise<{ repoPath: string; worktreesDir: string; originPath: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'happy-deliver-'));
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
    return { repoPath, worktreesDir, originPath };
}

describe('detectGitPlatform / extractRemoteHost', () => {
    it('detects github and gitlab from ssh and https remotes', () => {
        expect(detectGitPlatform('git@github.com:org/repo.git')).toBe('github');
        expect(detectGitPlatform('https://github.com/org/repo.git')).toBe('github');
        expect(detectGitPlatform('git@gitlab.example.com:org/repo.git')).toBe('gitlab');
        expect(detectGitPlatform('ssh://git@gitlab.com/org/repo.git')).toBe('gitlab');
        expect(detectGitPlatform('https://bitbucket.org/org/repo.git')).toBeNull();
    });

    it('extracts host from scp-like and url remotes', () => {
        expect(extractRemoteHost('git@github.com:org/repo.git')).toBe('github.com');
        expect(extractRemoteHost('https://gitlab.com/org/repo.git')).toBe('gitlab.com');
    });
});

describe('resolvePrContent', () => {
    it('prefers pr.md (first line title, remainder body)', () => {
        const content = resolvePrContent({ prMarkdown: '# Add widget\n\nDoes the thing.\n', branch: 'happy/a/b' });
        expect(content).toEqual({ title: 'Add widget', body: 'Does the thing.' });
    });

    it('falls back to plan.md first section as title with empty body', () => {
        const content = resolvePrContent({ planMarkdown: '# Plan: refactor\n\n- step 1\n', branch: 'happy/a/b' });
        expect(content).toEqual({ title: 'Plan: refactor', body: '' });
    });

    it('falls back to the branch name when no artifacts exist', () => {
        expect(resolvePrContent({ branch: 'happy/a/b' })).toEqual({ title: 'happy/a/b', body: '' });
    });
});

describe('deliverTask', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        tempDirs.length = 0;
    });

    it('pushes the branch and creates a PR from pr.md content', async () => {
        const { repoPath, worktreesDir, originPath } = await makeRepo();
        const { worktreePath } = await prepareTaskWorktree(
            { taskId: 'd1', repoPath, baseBranch: 'main', workBranch: 'happy/alice/feature' },
            { worktreesDir },
        );
        await writeFile(path.join(worktreePath, 'file.txt'), 'hello\n');
        await writeFile(path.join(worktreePath, TASK_ARTIFACT_DIR, 'pr.md'), '# My feature\n\nBody text.\n');
        git(worktreePath, 'add', '.');
        git(worktreePath, 'commit', '-m', 'feat: add file');

        const calls: CreatePullRequestInput[] = [];
        const result = await deliverTask(
            { worktreePath, baseBranch: 'main', platform: 'github' },
            {
                createPullRequest: async (input) => {
                    calls.push(input);
                    return { url: 'https://example.test/pr/1' };
                },
            },
        );

        expect(result).toEqual({ prUrl: 'https://example.test/pr/1', workBranch: 'happy/alice/feature', platform: 'github' });
        expect(calls[0]).toMatchObject({ headBranch: 'happy/alice/feature', baseBranch: 'main', title: 'My feature', body: 'Body text.' });
        // branch really landed on origin
        const branches = execFileSync('git', ['-C', originPath, 'branch', '--list', 'happy/alice/feature']).toString();
        expect(branches).toContain('happy/alice/feature');
    });

    it('refuses to deliver a branch without the happy/ prefix', async () => {
        const { repoPath, worktreesDir } = await makeRepo();
        // Prepare a valid worktree, then move it onto a non-task branch.
        const { worktreePath } = await prepareTaskWorktree(
            { taskId: 'd2', repoPath, baseBranch: 'main', workBranch: 'happy/x/y' },
            { worktreesDir },
        );
        git(worktreePath, 'checkout', '-b', 'main-copy');
        await expect(
            deliverTask({ worktreePath, baseBranch: 'main', platform: 'github' }, { createPullRequest: async () => ({ url: 'x' }) }),
        ).rejects.toThrow(/not a happy\/ task branch/);
    });

    it('errors when the platform cannot be detected and none is provided', async () => {
        const { repoPath, worktreesDir } = await makeRepo();
        const { worktreePath } = await prepareTaskWorktree(
            { taskId: 'd3', repoPath, baseBranch: 'main', workBranch: 'happy/x/z' },
            { worktreesDir },
        );
        // origin points at a local bare path → no github/gitlab host.
        await expect(
            deliverTask({ worktreePath, baseBranch: 'main' }, { createPullRequest: async () => ({ url: 'x' }) }),
        ).rejects.toThrow(/could not detect GitHub\/GitLab/);
    });
});

describe('cleanupTask', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
        tempDirs.length = 0;
    });

    it('keeps the worktree by default', async () => {
        const { repoPath, worktreesDir } = await makeRepo();
        const { worktreePath } = await prepareTaskWorktree(
            { taskId: 'c1', repoPath, baseBranch: 'main', workBranch: 'happy/x/keep' },
            { worktreesDir },
        );
        const result = await cleanupTask({ worktreePath });
        expect(result).toEqual({ removed: false, worktreePath });
        expect(existsSync(worktreePath)).toBe(true);
    });

    it('removes the worktree when keepWorktree is false but leaves the branch', async () => {
        const { repoPath, worktreesDir } = await makeRepo();
        const { worktreePath } = await prepareTaskWorktree(
            { taskId: 'c2', repoPath, baseBranch: 'main', workBranch: 'happy/x/drop' },
            { worktreesDir },
        );
        const result = await cleanupTask({ worktreePath, keepWorktree: false });
        expect(result.removed).toBe(true);
        expect(existsSync(worktreePath)).toBe(false);
        expect(await listWorktreePaths(repoPath)).not.toContain(worktreePath);
        // branch still exists in the repo
        const branches = execFileSync('git', ['-C', repoPath, 'branch', '--list', 'happy/x/drop']).toString();
        expect(branches).toContain('happy/x/drop');
    });

    it('is idempotent when the worktree is already gone', async () => {
        const { repoPath, worktreesDir } = await makeRepo();
        const { worktreePath } = await prepareTaskWorktree(
            { taskId: 'c3', repoPath, baseBranch: 'main', workBranch: 'happy/x/idem' },
            { worktreesDir },
        );
        await cleanupTask({ worktreePath, keepWorktree: false });
        const again = await cleanupTask({ worktreePath, keepWorktree: false });
        expect(again.removed).toBe(true);
    });
});
