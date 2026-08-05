import { AgentAuthMode } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTeamAgentEnv } from "@/team/agentAuth";

describe("buildTeamAgentEnv", () => {
    const savedEnv = {
        TEAM_ANTHROPIC_API_KEY: process.env.TEAM_ANTHROPIC_API_KEY,
        TEAM_ANTHROPIC_BASE_URL: process.env.TEAM_ANTHROPIC_BASE_URL,
        TEAM_OPENAI_API_KEY: process.env.TEAM_OPENAI_API_KEY,
        TEAM_OPENAI_BASE_URL: process.env.TEAM_OPENAI_BASE_URL,
    };

    beforeEach(() => {
        delete process.env.TEAM_ANTHROPIC_API_KEY;
        delete process.env.TEAM_ANTHROPIC_BASE_URL;
        delete process.env.TEAM_OPENAI_API_KEY;
        delete process.env.TEAM_OPENAI_BASE_URL;
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    it("sets and clears both agents when both company keys are configured", () => {
        process.env.TEAM_ANTHROPIC_API_KEY = "anthropic-secret";
        process.env.TEAM_ANTHROPIC_BASE_URL = "https://gw.example.com";
        process.env.TEAM_OPENAI_API_KEY = "openai-secret";
        process.env.TEAM_OPENAI_BASE_URL = "https://gw.example.com";

        const result = buildTeamAgentEnv({
            claudeAuthMode: AgentAuthMode.COMPANY_API,
            codexAuthMode: AgentAuthMode.COMPANY_API,
        });

        expect(result.env).toEqual({
            ANTHROPIC_API_KEY: "anthropic-secret",
            ANTHROPIC_BASE_URL: "https://gw.example.com",
            OPENAI_API_KEY: "openai-secret",
            OPENAI_BASE_URL: "https://gw.example.com",
        });
        expect(result.clearKeys).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
        expect(result.warnings).toEqual([]);
    });

    it("does not let a missing Codex key block or wipe the Claude update", () => {
        process.env.TEAM_ANTHROPIC_API_KEY = "anthropic-secret";

        const result = buildTeamAgentEnv({
            claudeAuthMode: AgentAuthMode.COMPANY_API,
            codexAuthMode: AgentAuthMode.COMPANY_API,
        });

        expect(result.env).toEqual({ ANTHROPIC_API_KEY: "anthropic-secret" });
        expect(result.clearKeys).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
        expect(result.warnings).toEqual(["TEAM_OPENAI_API_KEY is not configured; Codex env left unchanged"]);
    });

    it("does not let a missing Claude key block or wipe the Codex update", () => {
        process.env.TEAM_OPENAI_API_KEY = "openai-secret";

        const result = buildTeamAgentEnv({
            claudeAuthMode: AgentAuthMode.COMPANY_API,
            codexAuthMode: AgentAuthMode.COMPANY_API,
        });

        expect(result.env).toEqual({ OPENAI_API_KEY: "openai-secret" });
        expect(result.clearKeys).toEqual(["OPENAI_API_KEY", "OPENAI_BASE_URL"]);
        expect(result.warnings).toEqual(["TEAM_ANTHROPIC_API_KEY is not configured; Claude env left unchanged"]);
    });

    it("clears an agent's company vars when it switches to personal OAuth", () => {
        process.env.TEAM_ANTHROPIC_API_KEY = "anthropic-secret";

        const result = buildTeamAgentEnv({
            claudeAuthMode: AgentAuthMode.PERSONAL_OAUTH,
            codexAuthMode: AgentAuthMode.PERSONAL_OAUTH,
        });

        expect(result.env).toEqual({});
        expect(result.clearKeys).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
        expect(result.warnings).toEqual([]);
    });
});
