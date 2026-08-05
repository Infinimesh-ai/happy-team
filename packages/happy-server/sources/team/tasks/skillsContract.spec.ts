import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_VERSION, lintSkillMd, parseSkillsYaml, validateSkillsDirectory } from "./skillsContract";

const tempDirs: string[] = [];

describe("parseSkillsYaml", () => {
    it("reads contractVersion and the projects map", () => {
        const parsed = parseSkillsYaml("contractVersion: 1\nprojects:\n  Acme: projects/Acme/acme-sop\n");
        expect(parsed.contractVersion).toBe(1);
        expect(parsed.projects).toEqual({ Acme: "projects/Acme/acme-sop" });
    });
});

describe("lintSkillMd", () => {
    it("flags an over-budget SKILL.md", () => {
        const content = Array.from({ length: 250 }, () => "x").join("\n");
        expect(lintSkillMd(content, { lineBudget: 200 })[0]).toMatch(/over the 200-line budget/);
    });
    it("requires repo and validation on project skills", () => {
        const errors = lintSkillMd("---\ntitle: t\n---\n# skill\n", { requireProjectFields: true });
        expect(errors).toEqual([
            "project SKILL.md is missing the `repo:` field",
            "project SKILL.md is missing the `validation:` field",
        ]);
    });
});

describe("validateSkillsDirectory", () => {
    afterEach(async () => {
        await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
        tempDirs.length = 0;
    });

    async function makeSkills(opts: { version?: string; withFields?: boolean } = {}): Promise<string> {
        const dir = await mkdtemp(path.join(tmpdir(), "happy-contract-"));
        tempDirs.push(dir);
        await writeFile(path.join(dir, "skills.yaml"), `contractVersion: ${opts.version ?? CONTRACT_VERSION}\n`);
        const skillDir = path.join(dir, "projects", "Acme", "acme-sop");
        await mkdir(skillDir, { recursive: true });
        const fm = opts.withFields
            ? "---\nrepo: github.com/acme/app\nvalidation: make test\n---\n# Acme\n"
            : "---\ntitle: Acme\n---\n# Acme\n";
        await writeFile(path.join(skillDir, "SKILL.md"), fm);
        return dir;
    }

    it("accepts a well-formed skills repo", async () => {
        const result = await validateSkillsDirectory(await makeSkills({ withFields: true }));
        expect(result.valid).toBe(true);
        expect(result.contractVersion).toBe(CONTRACT_VERSION);
    });

    it("rejects a repo whose project skill lacks contract fields", async () => {
        const result = await validateSkillsDirectory(await makeSkills({ withFields: false }));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /repo:/.test(e))).toBe(true);
        expect(result.errors.some((e) => /validation:/.test(e))).toBe(true);
    });

    it("rejects an unsupported contractVersion", async () => {
        const result = await validateSkillsDirectory(await makeSkills({ version: "99", withFields: true }));
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /not supported/.test(e))).toBe(true);
    });
});
