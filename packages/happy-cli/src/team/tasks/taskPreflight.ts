/**
 * Task delivery prerequisites detection (plan §8, §12 risk row, milestone C3.3).
 *
 * Before a task can deliver it needs an authenticated `gh` / `glab` and a
 * pushable Git identity, and skills injection needs the machine skills clone.
 * This surfaces missing prerequisites as warnings at provisioning / launch time
 * so a task does not run all the way to delivery only to fail there.
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { resolveSkillsDir } from './skillsInjection';

const execFileAsync = promisify(execFile);

export interface CliAuthStatus {
    available: boolean;
    authenticated: boolean;
}

export interface TaskPrerequisites {
    gh: CliAuthStatus;
    glab: CliAuthStatus;
    skillsClone: boolean;
    warnings: string[];
}

/** Runs a CLI and resolves whether it exited 0 (injectable for tests). */
export interface CommandProbe {
    (command: string, args: string[]): Promise<{ ok: boolean; available: boolean }>;
}

const defaultProbe: CommandProbe = async (command, args) => {
    try {
        await execFileAsync(command, args, { timeout: 10_000 });
        return { ok: true, available: true };
    } catch (error) {
        const code = (error as { code?: string }).code;
        // ENOENT means the binary is missing; a non-zero exit means present but not ok.
        if (code === 'ENOENT') return { ok: false, available: false };
        return { ok: false, available: true };
    }
};

export interface DetectPrereqDeps {
    probe?: CommandProbe;
    skillsDir?: string;
}

/** Detect gh/glab auth and skills-clone presence, collecting warnings. */
export async function detectTaskPrerequisites(deps: DetectPrereqDeps = {}): Promise<TaskPrerequisites> {
    const probe = deps.probe ?? defaultProbe;
    const [gh, glab] = await Promise.all([
        probe('gh', ['auth', 'status']),
        probe('glab', ['auth', 'status']),
    ]);
    const skillsClone = existsSync(resolveSkillsDir(deps.skillsDir));

    const warnings: string[] = [];
    if (!gh.available && !glab.available) {
        warnings.push('Neither gh nor glab is installed — task delivery (PR/MR creation) will fail.');
    }
    if (gh.available && !gh.ok) {
        warnings.push('gh is installed but not authenticated — run `gh auth login`.');
    }
    if (glab.available && !glab.ok) {
        warnings.push('glab is installed but not authenticated — run `glab auth login`.');
    }
    if (!skillsClone) {
        warnings.push('No Team-Skills clone on this machine — tasks will run without skills injection.');
    }

    return {
        gh: { available: gh.available, authenticated: gh.ok },
        glab: { available: glab.available, authenticated: glab.ok },
        skillsClone,
        warnings,
    };
}
