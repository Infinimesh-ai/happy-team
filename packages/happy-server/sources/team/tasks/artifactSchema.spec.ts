import { describe, expect, it } from "vitest";
import { parseFrontmatter, validateArtifactByPath, validateFindingsArtifact, validatePlanArtifact, validatePrArtifact } from "./artifactSchema";

describe("parseFrontmatter", () => {
    it("splits frontmatter from body", () => {
        const parsed = parseFrontmatter("---\ngoal: do X\nfoo: bar\n---\n# body\n- [ ] a\n");
        expect(parsed.frontmatter).toEqual({ goal: "do X", foo: "bar" });
        expect(parsed.body).toContain("- [ ] a");
    });

    it("treats content without frontmatter as all body", () => {
        expect(parseFrontmatter("just text").frontmatter).toEqual({});
    });
});

describe("validatePlanArtifact", () => {
    it("accepts a goal + checklist", () => {
        expect(validatePlanArtifact("---\ngoal: ship it\n---\n- [ ] step one\n").valid).toBe(true);
    });
    it("rejects a missing goal or empty checklist", () => {
        expect(validatePlanArtifact("---\n---\n- [ ] step\n").errors[0]).toMatch(/goal/);
        expect(validatePlanArtifact("---\ngoal: g\n---\nno items here\n").errors[0]).toMatch(/checklist/);
    });
});

describe("validateFindingsArtifact", () => {
    it("accepts passed with no findings", () => {
        expect(validateFindingsArtifact("---\nverdict: passed\n---\nlgtm\n").valid).toBe(true);
    });
    it("requires findings when failed", () => {
        expect(validateFindingsArtifact("---\nverdict: failed\n---\n").errors[0]).toMatch(/no findings/);
        expect(validateFindingsArtifact("---\nverdict: failed\n---\n- foo.ts:1 broken\n").valid).toBe(true);
    });
    it("rejects an invalid verdict", () => {
        expect(validateFindingsArtifact("---\nverdict: maybe\n---\n").errors[0]).toMatch(/verdict/);
    });
});

describe("validatePrArtifact", () => {
    it("accepts a title in frontmatter or first line", () => {
        expect(validatePrArtifact("---\ntitle: My PR\n---\n").valid).toBe(true);
        expect(validatePrArtifact("# My PR\n\nbody\n").valid).toBe(true);
    });
    it("rejects an empty pr", () => {
        expect(validatePrArtifact("").valid).toBe(false);
        expect(validatePrArtifact("---\ntitle: \n---\n").valid).toBe(false);
    });
});

describe("validateArtifactByPath", () => {
    it("routes by filename and passes unknown paths", () => {
        expect(validateArtifactByPath(".happy-task/plan.md", "---\n---\n").valid).toBe(false);
        expect(validateArtifactByPath(".happy-task/other.md", "").valid).toBe(true);
    });
});
