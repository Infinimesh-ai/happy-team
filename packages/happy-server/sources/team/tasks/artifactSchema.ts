/**
 * Artifact content contract (plan §9.1, milestone C4.1).
 *
 * The completion determination is upgraded from "file exists" to "parses and has
 * the required fields" — this closes the space for fake completion (an empty or
 * malformed plan/findings/pr no longer counts as done). Each artifact carries a
 * small YAML frontmatter block plus a body; these validators check the minimum
 * structured shape without pulling in a YAML dependency.
 */

export interface ParsedArtifact {
    frontmatter: Record<string, string>;
    body: string;
}

export interface ArtifactValidation {
    valid: boolean;
    errors: string[];
}

/** Split leading `--- ... ---` frontmatter (scalar key: value lines) from the body. */
export function parseFrontmatter(markdown: string): ParsedArtifact {
    const normalized = markdown.replace(/\r\n/g, "\n");
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
    if (!match) return { frontmatter: {}, body: normalized };
    const frontmatter: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
        const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
        if (kv) frontmatter[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
    return { frontmatter, body: match[2] };
}

function hasChecklistItem(body: string): boolean {
    return /^\s*[-*]\s+\[[ xX]\]\s+\S/m.test(body);
}

function hasBullet(body: string): boolean {
    return /^\s*[-*]\s+\S/m.test(body);
}

/** plan.md: frontmatter `goal` + at least one checklist item in the body. */
export function validatePlanArtifact(markdown: string): ArtifactValidation {
    const { frontmatter, body } = parseFrontmatter(markdown);
    const errors: string[] = [];
    if (!frontmatter.goal) errors.push("plan.md frontmatter is missing `goal`");
    if (!hasChecklistItem(body)) errors.push("plan.md has no checklist items (`- [ ] ...`)");
    return { valid: errors.length === 0, errors };
}

/** findings.md: frontmatter `verdict` (passed|failed); a failed verdict needs findings. */
export function validateFindingsArtifact(markdown: string): ArtifactValidation {
    const { frontmatter, body } = parseFrontmatter(markdown);
    const errors: string[] = [];
    const verdict = frontmatter.verdict;
    if (verdict !== "passed" && verdict !== "failed") {
        errors.push('findings.md frontmatter `verdict` must be "passed" or "failed"');
    }
    if (verdict === "failed" && !hasBullet(body)) {
        errors.push("findings.md has verdict failed but lists no findings");
    }
    return { valid: errors.length === 0, errors };
}

/** pr.md: a title, either as frontmatter `title` or the first non-empty line. */
export function validatePrArtifact(markdown: string): ArtifactValidation {
    const { frontmatter, body } = parseFrontmatter(markdown);
    const errors: string[] = [];
    const firstLine = body.split("\n").find((line) => line.trim().length > 0)?.replace(/^#+\s*/, "").trim();
    if (!frontmatter.title && !firstLine) errors.push("pr.md has no title");
    return { valid: errors.length === 0, errors };
}

/** Validate an artifact by its worktree-relative path; unknown paths pass. */
export function validateArtifactByPath(artifactPath: string, content: string): ArtifactValidation {
    if (artifactPath.endsWith("plan.md")) return validatePlanArtifact(content);
    if (artifactPath.endsWith("findings.md")) return validateFindingsArtifact(content);
    if (artifactPath.endsWith("pr.md")) return validatePrArtifact(content);
    return { valid: true, errors: [] };
}
