/**
 * Single registration point for cloud-agent task daemon RPCs (plan §8).
 *
 * apiMachine calls this once with the machine RpcHandlerManager; every task
 * handler (prepare-worktree, and later deliver / cleanup) is wired here so new
 * task code stays in this module tree and the daemon has one attachment point.
 */
import { logger } from '@/ui/logger';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { prepareTaskWorktree, type PrepareWorktreeParams } from './prepareWorktree';
import { cleanupTask, deliverTask, type CleanupTaskParams, type DeliverTaskParams } from './deliverTask';

export function registerTaskHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler('task-prepare-worktree', async (params: PrepareWorktreeParams) => {
        logger.debug('[TASK RPC] task-prepare-worktree', params);
        return prepareTaskWorktree(params || ({} as PrepareWorktreeParams));
    });

    rpcHandlerManager.registerHandler('task-deliver', async (params: DeliverTaskParams) => {
        logger.debug('[TASK RPC] task-deliver', params);
        return deliverTask(params || ({} as DeliverTaskParams));
    });

    rpcHandlerManager.registerHandler('task-cleanup', async (params: CleanupTaskParams) => {
        logger.debug('[TASK RPC] task-cleanup', params);
        return cleanupTask(params || ({} as CleanupTaskParams));
    });
}
