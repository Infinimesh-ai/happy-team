/**
 * Cloud-agent task templates (plan §6).
 *
 * A template is a static description of how a task is orchestrated: which agent
 * runs each stage, the prompt it receives, which artifacts prove the stage is
 * done, and the allowed transitions between stages. Templates are server-side
 * TypeScript constants for the first version — the structure is already "data"
 * so a later move to the database is a small step.
 *
 * Only stages that are real agent sessions live in `stages`. The `deliver`
 * pseudo-stage is a deterministic daemon step (git push + gh/glab, plan §8), so
 * it appears only as a transition target, never as a `stages` entry.
 */

/** Agents an orchestration stage can run on (matches spawn-happy-session). */
export type TaskAgent = "claude" | "codex";

/** Permission mode a stage session runs under (plan §6). */
export type StagePermissionMode = "plan" | "auto";

/**
 * Guard on a transition edge. `verify_passed` / `verify_failed_within_budget`
 * are evaluated by the state machine against the verify verdict and round
 * budget (used from T3 onward); undefined means an unconditional edge.
 */
export type TransitionCondition = "verify_passed" | "verify_failed_within_budget";

export interface TaskStageDefinition {
    agent: TaskAgent;
    /** Optional default model; overridable per-task at launch (stageOverrides). */
    model?: string;
    /**
     * Prompt handed to the stage session. Supports `{{token}}` placeholders
     * substituted by {@link renderStagePrompt} (goalPrompt / artifact paths).
     */
    promptTemplate: string;
    /**
     * Artifact paths (relative to the worktree) whose existence is the fallback
     * completion signal for this stage (plan §6, three-signal combination).
     */
    expectedArtifacts: string[];
    permissionMode: StagePermissionMode;
    /**
     * When true the daemon runs the project's validation gate before the stage
     * starts and its real output is injected as `{{validationOutput}}` (plan
     * §9.1 verification materialization). Used by verify stages.
     */
    injectValidation?: boolean;
}

export interface TaskTransition {
    /** Source stage; `null` marks the entry edge (task start → first stage). */
    from: string | null;
    to: string;
    /** supervised mode pauses on this edge for human approval (plan §6). */
    requiresApproval?: boolean;
    condition?: TransitionCondition;
}

export interface TaskTemplate {
    id: string;
    stages: Record<string, TaskStageDefinition>;
    transitions: TaskTransition[];
}

/** Worktree-relative directory holding the file hand-off medium (plan §4). */
export const TASK_ARTIFACT_DIR = ".happy-task";

/** Conventional artifact paths inside {@link TASK_ARTIFACT_DIR}. */
export const TASK_ARTIFACTS = {
    plan: `${TASK_ARTIFACT_DIR}/plan.md`,
    findings: `${TASK_ARTIFACT_DIR}/findings.md`,
    pr: `${TASK_ARTIFACT_DIR}/pr.md`,
} as const;

/** Terminal daemon-executed delivery step (not an agent session). */
export const DELIVER_STAGE = "deliver";

/**
 * Placeholder tokens accepted by {@link renderStagePrompt}. Unknown tokens
 * render as empty strings, so this interface is the single source of truth for
 * what a template author may reference.
 */
export interface StagePromptVariables {
    goalPrompt: string;
    planPath?: string;
    findingsPath?: string;
    prPath?: string;
    validationOutput?: string;
}

const T1_EXECUTE_ONLY: TaskTemplate = {
    id: "execute-only",
    stages: {
        execute: {
            agent: "claude",
            promptTemplate: [
                "You are executing a coding task on an isolated git worktree.",
                "",
                "Task goal:",
                "{{goalPrompt}}",
                "",
                "Instructions:",
                "- Implement the change directly in this worktree.",
                "- Commit your work with conventional commit messages.",
                "- When finished, write the pull-request title and body to {{prPath}}",
                "  (first line = title, blank line, then the body).",
                "Do not push or open the pull request yourself — delivery is handled",
                "automatically once this session exits and {{prPath}} exists.",
            ].join("\n"),
            expectedArtifacts: [TASK_ARTIFACTS.pr],
            permissionMode: "auto",
        },
    },
    transitions: [
        { from: null, to: "execute" },
        { from: "execute", to: DELIVER_STAGE },
    ],
};

const T2_PLAN_EXECUTE: TaskTemplate = {
    id: "plan-execute",
    stages: {
        plan: {
            agent: "claude",
            promptTemplate: [
                "You are planning a coding task on an isolated git worktree.",
                "",
                "Task goal:",
                "{{goalPrompt}}",
                "",
                "Instructions:",
                "- Do NOT modify code — you are in read-only planning mode.",
                "- Follow the team's planning standard mounted at .claude/skills/standards/",
                "  (Codex: .agents/skills/standards/), if present.",
                "- Investigate the repository and produce an ordered, checkable implementation",
                "  plan and write it to {{planPath}} in exactly this shape — YAML frontmatter",
                "  with a one-line goal, then the body with red-lines and a `- [ ]` checklist:",
                "  ---",
                "  goal: <one-line summary of the goal>",
                "  ---",
                "  <red-lines and context>",
                "  - [ ] <ordered implementation steps>",
                "The plan will be reviewed and approved before execution begins.",
            ].join("\n"),
            expectedArtifacts: [TASK_ARTIFACTS.plan],
            permissionMode: "plan",
        },
        execute: {
            agent: "codex",
            promptTemplate: [
                "You are executing an approved plan on an isolated git worktree.",
                "",
                "Task goal:",
                "{{goalPrompt}}",
                "",
                "Follow the approved plan at {{planPath}} exactly:",
                "- Implement each checklist item and commit with conventional commit messages.",
                "- When finished, write the pull-request title and body to {{prPath}}",
                "  (first line = title, blank line, then the body).",
                "Do not push or open the pull request yourself — delivery is automatic.",
            ].join("\n"),
            expectedArtifacts: [TASK_ARTIFACTS.pr],
            permissionMode: "auto",
        },
    },
    transitions: [
        { from: null, to: "plan" },
        { from: "plan", to: "execute", requiresApproval: true },
        { from: "execute", to: DELIVER_STAGE },
    ],
};

const T3_PLAN_EXECUTE_VERIFY: TaskTemplate = {
    id: "plan-execute-verify",
    stages: {
        plan: {
            agent: "claude",
            promptTemplate: T2_PLAN_EXECUTE.stages.plan.promptTemplate,
            expectedArtifacts: [TASK_ARTIFACTS.plan],
            permissionMode: "plan",
        },
        execute: {
            agent: "codex",
            promptTemplate: [
                "You are executing an approved plan on an isolated git worktree.",
                "",
                "Task goal:",
                "{{goalPrompt}}",
                "",
                "Follow the approved plan at {{planPath}} exactly.",
                "If a review findings file exists at {{findingsPath}}, this is a rework",
                "round: address every finding it lists first.",
                "- Implement each item and commit with conventional commit messages.",
                "- When finished, write the pull-request title and body to {{prPath}}.",
                "Do not push or open the pull request yourself — delivery is automatic.",
            ].join("\n"),
            expectedArtifacts: [TASK_ARTIFACTS.pr],
            permissionMode: "auto",
        },
        verify: {
            agent: "claude",
            promptTemplate: [
                "You are reviewing an implementation against its plan on a git worktree.",
                "",
                "Task goal:",
                "{{goalPrompt}}",
                "",
                "Evidence to check:",
                "- the plan and its checklist at {{planPath}}",
                "- the working-tree diff for this branch",
                "- the real output of the project's validation gate, already run for you:",
                "{{validationOutput}}",
                "",
                "Apply the team's reviewer standard and anti-fake-completion checklist",
                "mounted at .claude/skills/standards/ (Codex: .agents/skills/standards/).",
                "If everything passes, call complete_stage with verdict \"passed\".",
                "If not, write precise, located findings to {{findingsPath}} in exactly this",
                "shape — YAML frontmatter with the verdict, then one bullet per problem",
                "(file/line and what is wrong):",
                "  ---",
                "  verdict: failed",
                "  ---",
                "  - <file:line — what is wrong>",
                "then call complete_stage with verdict \"failed\". Do not pass on a hunch —",
                "cite the evidence.",
            ].join("\n"),
            expectedArtifacts: [],
            permissionMode: "auto",
            injectValidation: true,
        },
    },
    transitions: [
        { from: null, to: "plan" },
        { from: "plan", to: "execute", requiresApproval: true },
        { from: "execute", to: "verify" },
        { from: "verify", to: DELIVER_STAGE, condition: "verify_passed" },
        { from: "verify", to: "execute", condition: "verify_failed_within_budget" },
    ],
};

const T4_SKILLS_CURATOR: TaskTemplate = {
    id: "skills-curator",
    stages: {
        consolidate: {
            agent: "claude",
            promptTemplate: [
                "You are the skills curator running on the team's skills repository.",
                "",
                "Inputs (in this repo):",
                "- pending lessons in the lessons inbox",
                "- the telemetry report for the recent period",
                "",
                "Produce a single revision:",
                "- merge duplicate lessons; promote cross-project rules per the promotion",
                "  standard; propose retiring model-compensating rules that telemetry shows",
                "  have not fired in N periods.",
                "- every change MUST have a decision-log entry (durable vs model-compensating).",
                "Write the PR title and body to {{prPath}}. You only propose — a human merges.",
            ].join("\n"),
            expectedArtifacts: [TASK_ARTIFACTS.pr],
            permissionMode: "auto",
        },
        verify: {
            agent: "claude",
            promptTemplate: [
                "Review the curator's revision on this skills repository.",
                "Check the decision-log discipline: every content change has a matching",
                "decision-log entry with the correct durable/model-compensating classification,",
                "and retirements cite telemetry evidence.",
                "If the discipline holds, call complete_stage with verdict \"passed\"; otherwise",
                "write located findings to {{findingsPath}} (frontmatter `---` / `verdict: failed`",
                "/ `---`, then one bullet per problem) and complete_stage verdict \"failed\".",
            ].join("\n"),
            expectedArtifacts: [],
            permissionMode: "auto",
        },
    },
    transitions: [
        { from: null, to: "consolidate" },
        { from: "consolidate", to: "verify" },
        { from: "verify", to: DELIVER_STAGE, condition: "verify_passed" },
        { from: "verify", to: "consolidate", condition: "verify_failed_within_budget" },
    ],
};

/** All built-in templates, keyed by id. */
export const TASK_TEMPLATES: Record<string, TaskTemplate> = {
    [T1_EXECUTE_ONLY.id]: T1_EXECUTE_ONLY,
    [T2_PLAN_EXECUTE.id]: T2_PLAN_EXECUTE,
    [T3_PLAN_EXECUTE_VERIFY.id]: T3_PLAN_EXECUTE_VERIFY,
    [T4_SKILLS_CURATOR.id]: T4_SKILLS_CURATOR,
};

/** Look up a template by id, or undefined when unknown. */
export function getTaskTemplate(id: string): TaskTemplate | undefined {
    return TASK_TEMPLATES[id];
}

/** All built-in templates as a stable, id-sorted list (for GET /templates). */
export function listTaskTemplates(): TaskTemplate[] {
    return Object.values(TASK_TEMPLATES).sort((a, b) => a.id.localeCompare(b.id));
}

/** Look up a single stage definition within a template. */
export function getTaskStage(template: TaskTemplate, stage: string): TaskStageDefinition | undefined {
    return template.stages[stage];
}

/**
 * Resolve the first stage a task enters — the target of the `from: null` edge.
 * Returns undefined for a malformed template with no entry edge.
 */
export function getEntryStage(template: TaskTemplate): string | undefined {
    return template.transitions.find((transition) => transition.from === null)?.to;
}

const PLACEHOLDER_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Substitute `{{token}}` placeholders in a stage's promptTemplate. Unknown or
 * missing tokens are replaced with an empty string so a stale placeholder never
 * leaks literal `{{...}}` text into an agent prompt.
 */
export function renderStagePrompt(template: TaskTemplate, stage: string, variables: StagePromptVariables): string {
    const definition = getTaskStage(template, stage);
    if (!definition) {
        throw new Error(`Unknown stage "${stage}" for template "${template.id}"`);
    }
    const values: Record<string, string | undefined> = {
        goalPrompt: variables.goalPrompt,
        planPath: variables.planPath ?? TASK_ARTIFACTS.plan,
        findingsPath: variables.findingsPath ?? TASK_ARTIFACTS.findings,
        prPath: variables.prPath ?? TASK_ARTIFACTS.pr,
        validationOutput: variables.validationOutput ?? "(no validation gate configured)",
    };
    return definition.promptTemplate.replace(PLACEHOLDER_PATTERN, (_match, token: string) => values[token] ?? "");
}
