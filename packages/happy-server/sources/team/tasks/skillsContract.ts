/**
 * Skills content contract + validators (plan §9.1, §9.4; milestones C4.2–C4.3).
 *
 * The skills repo is pure content that must be machine-readable and stay within
 * a context budget. The product owns the validation: before a ref is
 * distributed, the server runs these checks and refuses an unfit ref. The
 * checks are:
 *   - skills.yaml declares a supported `contractVersion`
 *   - each project skill's SKILL.md carries `repo:` and `validation:` fields
 *   - each SKILL.md stays under the context-budget line limit (details belong in
 *     references loaded on demand — an oversized SKILL.md is a team-wide token tax)
 */
import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { parseFrontmatter } from "./artifactSchema";

/** Contract version this product build understands. */
export const CONTRACT_VERSION = 1;

/** Default SKILL.md line budget (plan §9.1 context-budget linter). */
export const DEFAULT_SKILL_LINE_BUDGET = 200;

export interface ContractValidation {
    valid: boolean;
    contractVersion: number | null;
    errors: string[];
}

export interface SkillsYaml {
    contractVersion: number | null;
    projects: Record<string, string>;
}

/** Parse a minimal skills.yaml (contractVersion + optional projects map). */
export function parseSkillsYaml(content: string): SkillsYaml {
    const result: SkillsYaml = { contractVersion: null, projects: {} };
    let inProjects = false;
    for (const raw of content.replace(/\r\n/g, "\n").split("\n")) {
        const line = raw.replace(/#.*$/, "");
        const version = /^contractVersion:\s*(\d+)\s*$/.exec(line);
        if (version) {
            result.contractVersion = Number.parseInt(version[1], 10);
            inProjects = false;
            continue;
        }
        if (/^projects:\s*$/.test(line)) {
            inProjects = true;
            continue;
        }
        if (inProjects) {
            const entry = /^\s+([A-Za-z0-9_.-]+):\s*(.+)\s*$/.exec(line);
            if (entry) result.projects[entry[1]] = entry[2].trim();
            else if (line.trim().length > 0 && !/^\s/.test(line)) inProjects = false;
        }
    }
    return result;
}

/** Lint a single SKILL.md: required fields + context budget. */
export function lintSkillMd(content: string, options?: { requireProjectFields?: boolean; lineBudget?: number }): string[] {
    const errors: string[] = [];
    const lineBudget = options?.lineBudget ?? DEFAULT_SKILL_LINE_BUDGET;
    const lines = content.replace(/\r\n/g, "\n").split("\n").length;
    if (lines > lineBudget) {
        errors.push(`SKILL.md is ${lines} lines, over the ${lineBudget}-line budget — move detail into references`);
    }
    if (options?.requireProjectFields) {
        const { frontmatter } = parseFrontmatter(content);
        if (!frontmatter.repo) errors.push("project SKILL.md is missing the `repo:` field");
        if (!frontmatter.validation) errors.push("project SKILL.md is missing the `validation:` field");
    }
    return errors;
}

/**
 * Validate a skills repository directory against the contract. Refuses an unfit
 * ref (server pre-distribution check, plan §9.4).
 */
export async function validateSkillsDirectory(skillsDir: string, options?: { lineBudget?: number }): Promise<ContractValidation> {
    const errors: string[] = [];

    const skillsYamlPath = path.join(skillsDir, "skills.yaml");
    let contractVersion: number | null = null;
    if (!existsSync(skillsYamlPath)) {
        errors.push("skills.yaml is missing");
    } else {
        const parsed = parseSkillsYaml(await readFile(skillsYamlPath, "utf8"));
        contractVersion = parsed.contractVersion;
        if (parsed.contractVersion === null) {
            errors.push("skills.yaml does not declare contractVersion");
        } else if (parsed.contractVersion !== CONTRACT_VERSION) {
            errors.push(`skills.yaml contractVersion ${parsed.contractVersion} is not supported (expected ${CONTRACT_VERSION})`);
        }
    }

    for (const skillMd of await findSkillFiles(skillsDir)) {
        const content = await readFile(skillMd.path, "utf8");
        const rel = path.relative(skillsDir, skillMd.path);
        for (const error of lintSkillMd(content, { requireProjectFields: skillMd.isProject, lineBudget: options?.lineBudget })) {
            errors.push(`${rel}: ${error}`);
        }
    }

    return { valid: errors.length === 0, contractVersion, errors };
}

async function findSkillFiles(skillsDir: string): Promise<{ path: string; isProject: boolean }[]> {
    const found: { path: string; isProject: boolean }[] = [];
    const projectsDir = path.join(skillsDir, "projects");
    if (existsSync(projectsDir)) {
        for (const project of await readdir(projectsDir).catch(() => [])) {
            const projectPath = path.join(projectsDir, project);
            for (const skill of await readdir(projectPath).catch(() => [])) {
                const skillMd = path.join(projectPath, skill, "SKILL.md");
                if (existsSync(skillMd)) found.push({ path: skillMd, isProject: true });
            }
        }
    }
    return found;
}
