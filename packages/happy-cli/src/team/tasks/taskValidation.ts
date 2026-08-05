/**
 * Daemon-executed acceptance gate (plan §9.1, milestone C4.4).
 *
 * The verify stage must be handed materialized evidence, not trust the agent to
 * find and honestly run the gates. The daemon resolves the matched project
 * skill's `validation:` command and runs it in the worktree, returning the real
 * output for the server to inject into the verify session. This is the step that
 * makes "verification materialization" a mechanism rather than a slogan.
 */
import { exec } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { logger } from '@/ui/logger';
import { currentBranch } from './taskGit';
import { runGit } from './taskGit';
import { matchProjectSkill, resolveSkillsDir } from './skillsInjection';

const execAsync = promisify(exec);
const MAX_OUTPUT = 16 * 1024;

export interface RunValidationParams {
    worktreePath: string;
}

export interface ValidationResult {
    command: string | null;
    exitCode: number | null;
    output: string;
}

/** Resolve the project's `validation:` command from the matched project skill. */
export async function resolveValidationCommand(worktreePath: string, skillsDirOverride?: string): Promise<string | null> {
    const skillsDir = resolveSkillsDir(skillsDirOverride);
    if (!existsSync(skillsDir)) return null;
    let remote: string;
    try {
        remote = (await runGit(worktreePath, ['remote', 'get-url', 'origin'])).stdout.trim();
    } catch {
        return null;
    }
    if (!remote) return null;
    const match = await matchProjectSkill(skillsDir, remote);
    if (!match) return null;
    const content = await readFile(path.join(match.source, 'SKILL.md'), 'utf8').catch(() => '');
    const validation = /^\s*validation:\s*(.+)\s*$/m.exec(content);
    return validation ? validation[1].trim() : null;
}

/**
 * Run the project's validation command in the worktree and return the real
 * (truncated) output. When no command is configured the result records that.
 */
export async function runTaskValidation(params: RunValidationParams, skillsDirOverride?: string): Promise<ValidationResult> {
    const worktreePath = params.worktreePath;
    // Touch currentBranch so a detached/invalid worktree fails fast and clearly.
    await currentBranch(worktreePath).catch(() => '');
    const command = await resolveValidationCommand(worktreePath, skillsDirOverride);
    if (!command) {
        return { command: null, exitCode: null, output: 'No validation command is configured for this project.' };
    }
    try {
        const { stdout, stderr } = await execAsync(command, { cwd: worktreePath, timeout: 10 * 60 * 1000, maxBuffer: MAX_OUTPUT * 8 });
        return { command, exitCode: 0, output: truncate(`${stdout}${stderr}`) };
    } catch (error) {
        const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
        logger.debug(`[TASK VALIDATION] command failed: ${err.message}`);
        return { command, exitCode: typeof err.code === 'number' ? err.code : 1, output: truncate(`${err.stdout ?? ''}${err.stderr ?? ''}${err.stdout || err.stderr ? '' : err.message ?? ''}`) };
    }
}

function truncate(text: string): string {
    if (text.length <= MAX_OUTPUT) return text;
    return `${text.slice(0, MAX_OUTPUT)}\n…[output truncated]`;
}
