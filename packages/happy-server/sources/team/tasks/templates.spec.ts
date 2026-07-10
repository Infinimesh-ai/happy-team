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
});
