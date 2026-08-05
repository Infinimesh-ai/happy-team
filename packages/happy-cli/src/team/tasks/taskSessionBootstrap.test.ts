import { describe, expect, it } from 'vitest';
import { readTaskSessionBootstrap } from './taskSessionBootstrap';

describe('readTaskSessionBootstrap', () => {
    it('returns null for a regular (non-task) session environment', () => {
        expect(readTaskSessionBootstrap({})).toBeNull();
        expect(readTaskSessionBootstrap({ HAPPY_TASK_ID: 't1' })).toBeNull();
        expect(readTaskSessionBootstrap({ HAPPY_TASK_PROMPT: 'do it' })).toBeNull();
    });

    it('reads the stage prompt for an auto stage without a mode override', () => {
        const bootstrap = readTaskSessionBootstrap({
            HAPPY_TASK_ID: 't1',
            HAPPY_TASK_PROMPT: 'Implement the change',
            HAPPY_TASK_PERMISSION_MODE: 'auto',
        });
        expect(bootstrap).toEqual({ prompt: 'Implement the change', permissionMode: undefined, model: undefined });
    });

    it('maps a plan stage to the plan permission mode and keeps the model', () => {
        const bootstrap = readTaskSessionBootstrap({
            HAPPY_TASK_ID: 't1',
            HAPPY_TASK_PROMPT: 'Plan the change',
            HAPPY_TASK_PERMISSION_MODE: 'plan',
            HAPPY_TASK_MODEL: 'claude-opus-4-8',
        });
        expect(bootstrap).toEqual({ prompt: 'Plan the change', permissionMode: 'plan', model: 'claude-opus-4-8' });
    });
});
