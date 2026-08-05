import { describe, expect, it } from "vitest";
import {
    DELIVER_STAGE,
    TASK_ARTIFACTS,
    getEntryStage,
    getTaskStage,
    getTaskTemplate,
    listTaskTemplates,
    renderStagePrompt,
} from "@/team/tasks/templates";
import { validateFindingsArtifact, validatePlanArtifact } from "@/team/tasks/artifactSchema";

describe("task templates", () => {
    it("exposes the built-in T1 execute-only template", () => {
        const template = getTaskTemplate("execute-only");
        expect(template).toBeDefined();
        expect(template!.id).toBe("execute-only");
        expect(Object.keys(template!.stages)).toEqual(["execute"]);
    });

    it("returns undefined for an unknown template id", () => {
        expect(getTaskTemplate("does-not-exist")).toBeUndefined();
    });

    it("lists templates sorted by id", () => {
        const ids = listTaskTemplates().map((template) => template.id);
        expect(ids).toEqual([...ids].sort());
        expect(ids).toContain("execute-only");
    });

    it("exposes T2 plan-execute with a plan-mode stage and an approval edge", () => {
        const template = getTaskTemplate("plan-execute")!;
        expect(Object.keys(template.stages)).toEqual(["plan", "execute"]);
        expect(template.stages.plan.permissionMode).toBe("plan");
        expect(template.stages.execute.agent).toBe("codex");
        const approvalEdge = template.transitions.find((t) => t.from === "plan");
        expect(approvalEdge).toMatchObject({ to: "execute", requiresApproval: true });
    });

    it("wires the entry edge to the execute stage and terminates at deliver", () => {
        const template = getTaskTemplate("execute-only")!;
        expect(getEntryStage(template)).toBe("execute");
        const executeEdge = template.transitions.find((transition) => transition.from === "execute");
        expect(executeEdge?.to).toBe(DELIVER_STAGE);
        // deliver is a daemon step, never an agent session.
        expect(getTaskStage(template, DELIVER_STAGE)).toBeUndefined();
    });

    it("marks the execute stage as auto permission with pr.md as the completion artifact", () => {
        const stage = getTaskStage(getTaskTemplate("execute-only")!, "execute")!;
        expect(stage.agent).toBe("claude");
        expect(stage.permissionMode).toBe("auto");
        expect(stage.expectedArtifacts).toEqual([TASK_ARTIFACTS.pr]);
    });

    it("exposes T3 plan-execute-verify with conditional verify edges", () => {
        const template = getTaskTemplate("plan-execute-verify")!;
        expect(Object.keys(template.stages)).toEqual(["plan", "execute", "verify"]);
        const verifyEdges = template.transitions.filter((t) => t.from === "verify");
        expect(verifyEdges.find((e) => e.condition === "verify_passed")?.to).toBe("deliver");
        expect(verifyEdges.find((e) => e.condition === "verify_failed_within_budget")?.to).toBe("execute");
    });

    it("exposes T4 skills-curator whose verify only ever proposes a PR (curator merges via human)", () => {
        const template = getTaskTemplate("skills-curator")!;
        expect(Object.keys(template.stages)).toEqual(["consolidate", "verify"]);
        const deliverEdge = template.transitions.find((t) => t.from === "verify" && t.condition === "verify_passed");
        expect(deliverEdge?.to).toBe("deliver");
    });

    it("substitutes goalPrompt and artifact-path placeholders", () => {
        const template = getTaskTemplate("execute-only")!;
        const prompt = renderStagePrompt(template, "execute", { goalPrompt: "Add a health check endpoint" });
        expect(prompt).toContain("Add a health check endpoint");
        expect(prompt).toContain(TASK_ARTIFACTS.pr);
        expect(prompt).not.toMatch(/\{\{.*\}\}/);
    });

    it("replaces unknown placeholders with empty string rather than leaking literal tokens", () => {
        const template = {
            id: "custom",
            stages: {
                execute: {
                    agent: "claude" as const,
                    promptTemplate: "goal={{goalPrompt}} junk={{nope}}",
                    expectedArtifacts: [],
                    permissionMode: "auto" as const,
                },
            },
            transitions: [],
        };
        const prompt = renderStagePrompt(template, "execute", { goalPrompt: "X" });
        expect(prompt).toBe("goal=X junk=");
    });

    it("throws when rendering a stage that does not exist", () => {
        const template = getTaskTemplate("execute-only")!;
        expect(() => renderStagePrompt(template, "missing", { goalPrompt: "X" })).toThrow(/Unknown stage/);
    });

    // Prompt ↔ artifact-contract round trip: an agent that follows the stage
    // prompt's format instructions to the letter must produce artifacts the
    // content contract (artifactSchema) accepts — otherwise every honest run
    // fails completion determination.
    it("plan prompt instructions produce a plan.md the content contract accepts", () => {
        const prompt = renderStagePrompt(getTaskTemplate("plan-execute")!, "plan", { goalPrompt: "X" });
        expect(prompt).toContain("goal: <one-line summary of the goal>");
        expect(prompt).toContain("- [ ]");
        const exemplaryPlan = [
            "---",
            "goal: Add a health check endpoint",
            "---",
            "Red-lines: no schema changes.",
            "- [ ] add GET /health route",
            "- [ ] add a test",
        ].join("\n");
        expect(validatePlanArtifact(exemplaryPlan)).toEqual({ valid: true, errors: [] });
    });

    it("verify prompt instructions produce a findings.md the content contract accepts", () => {
        const prompt = renderStagePrompt(getTaskTemplate("plan-execute-verify")!, "verify", { goalPrompt: "X" });
        expect(prompt).toContain("verdict: failed");
        const exemplaryFindings = [
            "---",
            "verdict: failed",
            "---",
            "- src/health.ts:12 — endpoint returns 200 even when the db is down",
        ].join("\n");
        expect(validateFindingsArtifact(exemplaryFindings)).toEqual({ valid: true, errors: [] });
    });
});
