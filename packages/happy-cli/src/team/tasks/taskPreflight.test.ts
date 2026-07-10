import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectTaskPrerequisites, type CommandProbe } from './taskPreflight';

const tempDirs: string[] = [];

function probeFor(map: Record<string, { ok: boolean; available: boolean }>): CommandProbe {
    return async (command) => map[command] ?? { ok: false, available: false };
}

describe('detectTaskPrerequisites', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
        tempDirs.length = 0;
    });

    it('is clean when gh is authenticated and a skills clone exists', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'happy-skills-dir-'));
        tempDirs.push(dir);
        const result = await detectTaskPrerequisites({
            probe: probeFor({ gh: { ok: true, available: true }, glab: { ok: false, available: false } }),
            skillsDir: dir,
        });
        expect(result.gh.authenticated).toBe(true);
        expect(result.skillsClone).toBe(true);
        expect(result.warnings).toEqual([]);
    });

    it('warns when no PR CLI is available and there is no skills clone', async () => {
        const result = await detectTaskPrerequisites({
            probe: probeFor({ gh: { ok: false, available: false }, glab: { ok: false, available: false } }),
            skillsDir: path.join(tmpdir(), 'definitely-missing-skills-dir'),
        });
        expect(result.warnings.some((w) => /Neither gh nor glab/.test(w))).toBe(true);
        expect(result.warnings.some((w) => /No Team-Skills clone/.test(w))).toBe(true);
    });

    it('warns when a CLI is installed but not authenticated', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'happy-skills-dir-'));
        tempDirs.push(dir);
        const result = await detectTaskPrerequisites({
            probe: probeFor({ gh: { ok: false, available: true }, glab: { ok: false, available: false } }),
            skillsDir: dir,
        });
        expect(result.warnings.some((w) => /gh is installed but not authenticated/.test(w))).toBe(true);
    });
});
