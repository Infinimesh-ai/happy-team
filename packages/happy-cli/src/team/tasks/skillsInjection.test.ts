/**
 * Skills injection adapter tests against a real local skills clone + worktree
 * (no network). Verifies HEAD recording, standards + repo-matched project skill
 * mounting, git exclusion, and the AGENTS.md block.
 */
import { execFileSync } from 'child_process';
import { existsSync, lstatSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { injectSkills, normalizeRepo } from './skillsInjection';

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): void {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

/** A skills clone (git repo) with standards + a project skill carrying a repo:. */
async function makeSkillsClone(projectRepoUrl: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'happy-skills-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    await mkdir(path.join(dir, 'standards'), { recursive: true });
    await writeFile(path.join(dir, 'standards', 'goal-driven.md'), '# goal driven\n');
    const skillDir = path.join(dir, 'projects', 'Acme', 'acme-sop');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), `---\nrepo: ${projectRepoUrl}\n---\n# Acme SOP\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'init skills');
    return dir;
}

async function makeWorktree(remoteUrl: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'happy-wt-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'remote', 'add', 'origin', remoteUrl);
    return dir;
}

describe('normalizeRepo', () => {
    it('normalizes ssh and https forms to the same key', () => {
        expect(normalizeRepo('git@github.com:acme/app.git')).toBe('github.com/acme/app');
        expect(normalizeRepo('https://github.com/acme/app.git')).toBe('github.com/acme/app');
    });
});

describe('injectSkills', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
        tempDirs.length = 0;
    });

    it('mounts standards + the repo-matched project skill, git-excluded, with HEAD recorded', async () => {
        const repoUrl = 'git@github.com:acme/app.git';
        const skillsDir = await makeSkillsClone('https://github.com/acme/app.git');
        const worktree = await makeWorktree(repoUrl);

        const result = await injectSkills(worktree, { skillsDir, repoRemoteUrl: repoUrl });
        expect(result.skillsCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(result.mounted.sort()).toEqual(['acme-sop', 'standards']);

        expect(lstatSync(path.join(worktree, '.claude/skills/standards')).isSymbolicLink()).toBe(true);
        expect(lstatSync(path.join(worktree, '.agents/skills/acme-sop')).isSymbolicLink()).toBe(true);
        expect(await readFile(path.join(worktree, 'AGENTS.md'), 'utf8')).toContain('## Team Skills');

        // The mounts must be git-excluded (not committable).
        const status = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { stdio: 'pipe' }).toString();
        expect(status).not.toMatch(/\.claude/);
        expect(status).not.toMatch(/\.agents/);
    });

    it('mounts only standards when no project skill matches the repo', async () => {
        const skillsDir = await makeSkillsClone('https://github.com/other/repo.git');
        const worktree = await makeWorktree('git@github.com:acme/app.git');
        const result = await injectSkills(worktree, { skillsDir, repoRemoteUrl: 'git@github.com:acme/app.git' });
        expect(result.mounted).toEqual(['standards']);
    });

    it('is a no-op returning null when there is no skills clone', async () => {
        const worktree = await makeWorktree('git@github.com:acme/app.git');
        const result = await injectSkills(worktree, { skillsDir: path.join(worktree, 'no-skills-here') });
        expect(result).toEqual({ skillsCommit: null, mounted: [] });
    });
});
