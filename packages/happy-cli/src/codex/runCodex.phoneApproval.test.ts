import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { CodexRemoteModeState } from './remoteModeState';

// Run the production inbound callback without booting a provider or daemon.
// The policy state is real; the approval/attachment boundaries record ordering.
function inbound(scope: Record<string, unknown>) {
    const source = ts.createSourceFile('runCodex.ts', readFileSync(new URL('./runCodex.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    let callback: ts.Node | undefined;
    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleUserMessage'
            && node.initializer && ts.isCallExpression(node.initializer)) {
            callback = node.initializer.arguments[0];
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    if (!callback) throw new Error('Inbound Codex callback not found');
    const js = ts.transpileModule(`return ${callback.getText(source)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return new Function(...Object.keys(scope), js)(...Object.values(scope));
}

describe('phone approval policy ordering', () => {
    it.each([
        ['yolo', 'yolo'],
        ['plan', 'default'],
    ])('resolves permission %s before consuming the approval', async (incoming, expected) => {
        const remoteModeState = new CodexRemoteModeState({ permissionMode: 'default' });
        const drainAttachmentsForUserMessage = vi.fn();
        const tryHandleTextPermissionResponse = vi.fn(() => {
            expect(remoteModeState.currentPermissionMode).toBe(expected);
            return true;
        });
        const handle = inbound({
            remoteModeState,
            permissionHandler: { tryHandleTextPermissionResponse },
            session: { drainAttachmentsForUserMessage },
            logger: { debug: vi.fn() },
        });
        await handle({ content: { text: '/approve pending-id' }, meta: { permissionMode: incoming } });
        expect(tryHandleTextPermissionResponse).toHaveBeenCalledWith('/approve pending-id');
        expect(drainAttachmentsForUserMessage).not.toHaveBeenCalled();
    });
});
