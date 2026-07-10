/**
 * Daemon validation-gate tests against a real local skills clone + worktree.
 * The command actually runs (writing a sentinel file), proving materialized
 * evidence rather than trusting the agent to run it.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveValidationCommand, runTaskValidation } from './taskValidation';

const tempDirs: string[] = [];

async function makeSkillsClone(repoUrl: string, validation: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'happy-val-skills-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
    const skillDir = path.join(dir, 'projects', 'Acme', 'acme-sop');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), `---\nrepo: ${repoUrl}\nvalidation: ${validation}\n---\n# Acme\n`);
    return dir;
}

async function makeWorktree(remoteUrl: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'happy-val-wt-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remoteUrl], { stdio: 'pipe' });
    return dir;
}

describe('daemon validation gate', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
        tempDirs.length = 0;
    });

    it('resolves the validation command from the matched project skill', async () => {
        const repoUrl = 'git@github.com:acme/app.git';
        const skillsDir = await makeSkillsClone('https://github.com/acme/app.git', 'echo hi');
        const worktree = await makeWorktree(repoUrl);
        expect(await resolveValidationCommand(worktree, skillsDir)).toBe('echo hi');
    });

    it('actually runs the gate in the worktree and captures the real output', async () => {
        const repoUrl = 'git@github.com:acme/app.git';
        const skillsDir = await makeSkillsClone('https://github.com/acme/app.git', 'echo GATE_OK > gate.txt && echo ran');
        const worktree = await makeWorktree(repoUrl);
        const result = await runTaskValidation({ worktreePath: worktree }, skillsDir);
        expect(result.command).toBe('echo GATE_OK > gate.txt && echo ran');
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain('ran');
        expect(existsSync(path.join(worktree, 'gate.txt'))).toBe(true);
    });

    it('reports a non-zero exit with output rather than throwing', async () => {
        const repoUrl = 'git@github.com:acme/app.git';
        const skillsDir = await makeSkillsClone('https://github.com/acme/app.git', 'echo boom && exit 3');
        const worktree = await makeWorktree(repoUrl);
        const result = await runTaskValidation({ worktreePath: worktree }, skillsDir);
        expect(result.exitCode).toBe(3);
        expect(result.output).toContain('boom');
    });

    it('records "no command" when the project has no validation gate', async () => {
        const worktree = await makeWorktree('git@github.com:acme/app.git');
        const result = await runTaskValidation({ worktreePath: worktree }, path.join(worktree, 'no-skills'));
        expect(result.command).toBeNull();
        expect(result.output).toMatch(/No validation command/);
    });
});
