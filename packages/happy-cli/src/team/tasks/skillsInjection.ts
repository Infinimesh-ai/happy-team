/**
 * Team-Skills injection adapter (plan §9.2, milestone C3). Absorbs the
 * link-project.sh mounting logic into a single daemon-side function so agent
 * skill injection lives in one place (plan §12 "注入逻辑集中在 daemon 一处
 * adapter").
 *
 * The machine keeps one clone of the skills repo (`~/.happy/team-skills/`,
 * provisioned ahead of time). At task preparation the adapter records its HEAD
 * (for audit → TeamTask.skillsCommit) and mounts the standards layer plus the
 * project skill matched by the repo remote — as git-excluded symlinks under
 * `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex). Nothing is
 * committed into the delivered branch.
 */
import { existsSync } from 'fs';
import { appendFile, mkdir, readdir, readFile, symlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { runGit } from './taskGit';

/** Resolve the machine's skills clone directory. */
export function resolveSkillsDir(override?: string): string {
    if (override) return override;
    if (process.env.HAPPY_SKILLS_DIR) return process.env.HAPPY_SKILLS_DIR.replace(/^~/, homedir());
    const home = configuration.happyHomeDir || path.join(homedir(), '.happy');
    return path.join(home, 'team-skills');
}

export interface InjectSkillsResult {
    skillsCommit: string | null;
    mounted: string[];
}

export interface InjectSkillsDeps {
    /** Machine skills clone; defaults to {@link resolveSkillsDir}. */
    skillsDir?: string;
    /** Remote URL of the task repo, used to match a project skill by `repo:`. */
    repoRemoteUrl?: string;
    /** Sync the clone to a ref before mounting (default true; skipped offline). */
    syncRef?: string;
}

/**
 * Mount the standards layer and any matched project skill into the worktree.
 * Returns the skills HEAD commit (or null when no skills clone is configured).
 */
export async function injectSkills(worktreePath: string, deps: InjectSkillsDeps = {}): Promise<InjectSkillsResult> {
    const skillsDir = resolveSkillsDir(deps.skillsDir);
    if (!existsSync(skillsDir) || !existsSync(path.join(skillsDir, '.git'))) {
        logger.debug(`[TASK SKILLS] no skills clone at ${skillsDir}; skipping injection`);
        return { skillsCommit: null, mounted: [] };
    }

    if (deps.syncRef) {
        try {
            await runGit(skillsDir, ['fetch', 'origin', deps.syncRef]);
            await runGit(skillsDir, ['checkout', deps.syncRef]);
            await runGit(skillsDir, ['reset', '--hard', `origin/${deps.syncRef}`]);
        } catch (error) {
            logger.debug(`[TASK SKILLS] sync of ${deps.syncRef} failed (using local HEAD): ${error}`);
        }
    }

    let skillsCommit: string | null = null;
    try {
        skillsCommit = (await runGit(skillsDir, ['rev-parse', 'HEAD'])).stdout.trim();
    } catch {
        skillsCommit = null;
    }

    const mounts: { name: string; source: string }[] = [];
    const standardsDir = path.join(skillsDir, 'standards');
    if (existsSync(standardsDir)) mounts.push({ name: 'standards', source: standardsDir });

    const projectSkill = deps.repoRemoteUrl ? await matchProjectSkill(skillsDir, deps.repoRemoteUrl) : null;
    if (projectSkill) mounts.push(projectSkill);

    const mounted: string[] = [];
    for (const mount of mounts) {
        await mountSkill(worktreePath, mount.name, mount.source);
        mounted.push(mount.name);
    }
    await excludeLocally(worktreePath, ['.claude/', '.agents/', 'AGENTS.md']);
    await writeAgentsBlock(worktreePath, mounted);

    logger.debug(`[TASK SKILLS] mounted [${mounted.join(', ')}] at HEAD ${skillsCommit ?? 'unknown'}`);
    return { skillsCommit, mounted };
}

/** Symlink a skill directory into both agents' skill discovery paths. */
async function mountSkill(worktreePath: string, name: string, source: string): Promise<void> {
    for (const base of ['.claude/skills', '.agents/skills']) {
        const linkDir = path.join(worktreePath, base);
        await mkdir(linkDir, { recursive: true });
        const link = path.join(linkDir, name);
        if (!existsSync(link)) {
            await symlink(source, link, 'dir').catch((error) => logger.debug(`[TASK SKILLS] link ${link} failed: ${error}`));
        }
    }
}

/** Find a project skill whose SKILL.md `repo:` matches the task repo remote. */
export async function matchProjectSkill(skillsDir: string, repoRemoteUrl: string): Promise<{ name: string; source: string } | null> {
    const projectsDir = path.join(skillsDir, 'projects');
    if (!existsSync(projectsDir)) return null;
    const needle = normalizeRepo(repoRemoteUrl);
    for (const project of await readdir(projectsDir).catch(() => [])) {
        const projectPath = path.join(projectsDir, project);
        for (const skill of await readdir(projectPath).catch(() => [])) {
            const skillPath = path.join(projectPath, skill);
            const skillMd = path.join(skillPath, 'SKILL.md');
            if (!existsSync(skillMd)) continue;
            const content = await readFile(skillMd, 'utf8').catch(() => '');
            const repoMatch = /^\s*repo:\s*(.+)\s*$/m.exec(content);
            if (repoMatch && normalizeRepo(repoMatch[1]) === needle) {
                return { name: skill, source: skillPath };
            }
        }
    }
    return null;
}

/** Normalize a git remote for matching (strip scheme, user, .git, trailing /). */
export function normalizeRepo(url: string): string {
    return url
        .trim()
        .replace(/^git@([^:]+):/, '$1/')
        .replace(/^[a-z]+:\/\//i, '')
        .replace(/^[^@]+@/, '')
        .replace(/\.git$/, '')
        .replace(/\/$/, '')
        .toLowerCase();
}

async function writeAgentsBlock(worktreePath: string, mounted: string[]): Promise<void> {
    if (mounted.length === 0) return;
    const agentsPath = path.join(worktreePath, 'AGENTS.md');
    const block = [
        '',
        '## Team Skills',
        '',
        'Team standards and project SOPs are mounted for this task under',
        '`.claude/skills/` (Claude Code) and `.agents/skills/` (Codex):',
        ...mounted.map((name) => `- ${name}`),
        '',
    ].join('\n');
    const existing = existsSync(agentsPath) ? await readFile(agentsPath, 'utf8') : '';
    if (existing.includes('## Team Skills')) return;
    await writeFile(agentsPath, `${existing}${block}`);
}

async function excludeLocally(worktreePath: string, entries: string[]): Promise<void> {
    try {
        const { stdout } = await runGit(worktreePath, ['rev-parse', '--git-path', 'info/exclude']);
        const excludePath = path.isAbsolute(stdout.trim()) ? stdout.trim() : path.join(worktreePath, stdout.trim());
        const existing = existsSync(excludePath) ? await readFile(excludePath, 'utf8') : '';
        const lines = new Set(existing.split('\n').map((line) => line.trim()));
        const toAdd = entries.filter((entry) => !lines.has(entry));
        if (toAdd.length > 0) {
            await appendFile(excludePath, `${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}${toAdd.join('\n')}\n`);
        }
    } catch (error) {
        logger.debug(`[TASK SKILLS] exclude failed: ${error}`);
    }
}
