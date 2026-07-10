/**
 * Task session bootstrap (plan §6/§7 stage spawn).
 *
 * A cloud-agent stage session is spawned by the daemon via spawn-happy-session,
 * which has no first-message parameter — the server's task state machine ships
 * the rendered stage prompt, permission mode and model as HAPPY_TASK_* variables
 * in the spawn environment instead. This module is the single place the session
 * entry points (runClaude / runAcp) read them back, so a task session seeds its
 * own message queue with the stage prompt and starts in the stage's permission
 * mode without any human input.
 */

export interface TaskSessionBootstrap {
    prompt: string;
    /**
     * Set only for "plan" stages (read-only planning mode). "auto" stages keep
     * the CLI's unattended default (yolo), which a task session needs anyway —
     * a restrictive mode would park the first tool call on a permission prompt
     * nobody is around to approve.
     */
    permissionMode?: 'plan';
    model?: string;
}

/**
 * Read the stage bootstrap from a spawn environment. Returns null when the
 * session is not a task stage (no HAPPY_TASK_PROMPT), so regular sessions are
 * untouched.
 */
export function readTaskSessionBootstrap(env: NodeJS.ProcessEnv = process.env): TaskSessionBootstrap | null {
    const prompt = env.HAPPY_TASK_PROMPT;
    if (!env.HAPPY_TASK_ID || !prompt) return null;
    return {
        prompt,
        permissionMode: env.HAPPY_TASK_PERMISSION_MODE === 'plan' ? 'plan' : undefined,
        model: env.HAPPY_TASK_MODEL || undefined,
    };
}
