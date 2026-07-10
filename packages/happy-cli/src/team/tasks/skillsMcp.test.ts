/**
 * skills-mcp core tests against a real local git skills clone (no network).
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendLesson, getSkill, scaffoldSkillsRepo } from './skillsMcp';

const tempDirs: string[] = [];

async function makeSkillsRepo(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'happy-skillsmcp-'));
    tempDirs.push(dir);
    execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com'], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T'], { stdio: 'pipe' });
    return dir;
}

describe('skills-mcp core', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
        tempDirs.length = 0;
    });

    it('getSkill reads a standards skill and a project skill', async () => {
        const dir = await makeSkillsRepo();
        await mkdir(path.join(dir, 'standards'), { recursive: true });
        await writeFile(path.join(dir, 'standards', 'reviewer-standard.md'), '# reviewer\n');
        await mkdir(path.join(dir, 'projects', 'Acme', 'acme-sop'), { recursive: true });
        await writeFile(path.join(dir, 'projects', 'Acme', 'acme-sop', 'SKILL.md'), '# acme sop\n');

        expect(await getSkill(dir, 'reviewer-standard')).toContain('# reviewer');
        expect(await getSkill(dir, 'acme-sop')).toContain('# acme sop');
        expect(await getSkill(dir, 'nope')).toBeNull();
    });

    it('appendLesson appends to the inbox and commits', async () => {
        const dir = await makeSkillsRepo();
        await writeFile(path.join(dir, 'README.md'), '# skills\n');
        execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' });
        execFileSync('git', ['-C', dir, 'commit', '-m', 'init'], { stdio: 'pipe' });

        const result = await appendLesson(dir, { project: 'Acme', lesson: 'Always run the linter before delivery.' });
        expect(result.committed).toBe(true);
        const inbox = await readFile(path.join(dir, 'lessons', 'inbox.md'), 'utf8');
        expect(inbox).toContain('Always run the linter before delivery.');
        expect(inbox).toContain('Acme');
        // committed to git history
        const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { stdio: 'pipe' }).toString();
        expect(log).toMatch(/lesson:/);
    });

    it('appendLesson rejects an empty lesson', async () => {
        const dir = await makeSkillsRepo();
        await expect(appendLesson(dir, { lesson: '   ' })).rejects.toThrow(/must not be empty/);
    });

    it('scaffoldSkillsRepo produces a contract-valid skeleton', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'happy-scaffold-'));
        tempDirs.push(dir);
        await scaffoldSkillsRepo(dir);
        expect(existsSync(path.join(dir, 'skills.yaml'))).toBe(true);
        expect(await readFile(path.join(dir, 'skills.yaml'), 'utf8')).toContain('contractVersion: 1');
        expect(existsSync(path.join(dir, 'standards', 'reviewer-standard.md'))).toBe(true);
        expect(existsSync(path.join(dir, 'lessons', 'inbox.md'))).toBe(true);
    });
});
