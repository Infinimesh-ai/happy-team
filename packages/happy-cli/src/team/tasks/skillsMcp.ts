/**
 * `happy skills-mcp` — the skills write-back MCP server (plan §9.4, milestone
 * C4.7). Absorbs the Team-Skills `mcp/server.py` into the product so the team
 * skills repo can stay pure content. Two tools operate on the machine's skills
 * clone: get_skill (read a skill) and append_lesson (append-only inbox +
 * auto commit/push with the member's Git credentials). The write path is always
 * git — merge stays a human decision.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'fs';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { logger } from '@/ui/logger';
import { resolveSkillsDir } from './skillsInjection';
import { runGit } from './taskGit';

/** Read a skill's SKILL.md by skill name (searches standards + projects). */
export async function getSkill(skillsDir: string, name: string): Promise<string | null> {
    const standards = path.join(skillsDir, 'standards', `${name}.md`);
    if (existsSync(standards)) return readFile(standards, 'utf8');
    const projectsDir = path.join(skillsDir, 'projects');
    if (existsSync(projectsDir)) {
        for (const project of await readdir(projectsDir).catch(() => [])) {
            const skillMd = path.join(projectsDir, project, name, 'SKILL.md');
            if (existsSync(skillMd)) return readFile(skillMd, 'utf8');
        }
    }
    return null;
}

/** Append a lesson to the append-only inbox and commit (+ best-effort push). */
export async function appendLesson(skillsDir: string, input: { project?: string; lesson: string }): Promise<{ committed: boolean }> {
    const lesson = input.lesson.trim();
    if (!lesson) throw new Error('lesson must not be empty');
    const inboxDir = path.join(skillsDir, 'lessons');
    await mkdir(inboxDir, { recursive: true });
    const inbox = path.join(inboxDir, 'inbox.md');
    const entry = `\n## ${new Date().toISOString()}${input.project ? ` — ${input.project}` : ''}\n\n${lesson}\n`;
    await appendFile(inbox, entry);

    try {
        await runGit(skillsDir, ['add', 'lessons/inbox.md']);
        await runGit(skillsDir, ['commit', '-m', `lesson: ${lesson.split('\n')[0].slice(0, 60)}`]);
        await runGit(skillsDir, ['push']).catch((error) => logger.debug(`[SKILLS MCP] push skipped: ${error}`));
        return { committed: true };
    } catch (error) {
        logger.debug(`[SKILLS MCP] commit failed: ${error}`);
        return { committed: false };
    }
}

/** Scaffold a fresh skills repo from the public template (plan §9.5). */
export async function scaffoldSkillsRepo(dir: string, contractVersion = 1): Promise<void> {
    await mkdir(path.join(dir, 'standards'), { recursive: true });
    await mkdir(path.join(dir, 'lessons'), { recursive: true });
    await writeFile(path.join(dir, 'skills.yaml'), `contractVersion: ${contractVersion}\nprojects:\n`);
    await writeFile(path.join(dir, 'standards', 'planner-standard.md'), '# Planner standard\n\nHow to write a plan.md that an executor can consume unambiguously.\n');
    await writeFile(path.join(dir, 'standards', 'executor-standard.md'), '# Executor standard\n\nGoal-driven execution loop for the task system.\n');
    await writeFile(path.join(dir, 'standards', 'reviewer-standard.md'), '# Reviewer standard\n\nAnti-fake-completion checklist and findings format.\n');
    await writeFile(path.join(dir, 'standards', 'decision-log.md'), '# Decision log\n\n| date | rule | classification | rationale |\n|---|---|---|---|\n');
    await writeFile(path.join(dir, 'lessons', 'inbox.md'), '# Lessons inbox\n');
}

export function createSkillsMcpServer(skillsDir: string): McpServer {
    const mcp = new McpServer({ name: 'Happy Skills', version: '1.0.0' });

    mcp.registerTool('get_skill', {
        description: 'Read a team skill (standards or a project skill) by name.',
        title: 'Get Skill',
        inputSchema: { name: z.string().describe('Skill name, e.g. "reviewer-standard" or a project skill') },
    }, async (args) => {
        const content = await getSkill(skillsDir, args.name);
        if (content === null) return { content: [{ type: 'text' as const, text: `Skill not found: ${args.name}` }], isError: true };
        return { content: [{ type: 'text' as const, text: content }], isError: false };
    });

    mcp.registerTool('append_lesson', {
        description: 'Append a lesson to the team skills lessons inbox (append-only; a human curates it later).',
        title: 'Append Lesson',
        inputSchema: {
            lesson: z.string().describe('The lesson learned'),
            project: z.string().optional().describe('Project the lesson relates to'),
        },
    }, async (args) => {
        try {
            const { committed } = await appendLesson(skillsDir, { project: args.project, lesson: args.lesson });
            return { content: [{ type: 'text' as const, text: committed ? 'Lesson recorded' : 'Lesson appended (not committed)' }], isError: false };
        } catch (error) {
            return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : 'failed'}` }], isError: true };
        }
    });

    return mcp;
}

/** Entry point for `happy skills-mcp`. */
export async function runSkillsMcp(): Promise<void> {
    const skillsDir = resolveSkillsDir();
    if (!existsSync(skillsDir)) {
        process.stderr.write(`happy skills-mcp: no skills clone at ${skillsDir}\n`);
        process.exitCode = 1;
        return;
    }
    await createSkillsMcpServer(skillsDir).connect(new StdioServerTransport());
}
