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
import { checkTaskArtifacts, cleanupTask, deliverTask, readTaskArtifact, writeTaskArtifact, type CheckArtifactsParams, type CleanupTaskParams, type DeliverTaskParams, type ReadArtifactParams, type WriteArtifactParams } from './deliverTask';
import { runTaskValidation, type RunValidationParams } from './taskValidation';

export function registerTaskHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler('task-prepare-worktree', async (params: PrepareWorktreeParams) => {
        logger.debug('[TASK RPC] task-prepare-worktree', params);
        return prepareTaskWorktree(params || ({} as PrepareWorktreeParams));
    });

    rpcHandlerManager.registerHandler('task-deliver', async (params: DeliverTaskParams) => {
        logger.debug('[TASK RPC] task-deliver', params);
        return deliverTask(params || ({} as DeliverTaskParams));
    });

    rpcHandlerManager.registerHandler('task-check-artifacts', async (params: CheckArtifactsParams) => {
        logger.debug('[TASK RPC] task-check-artifacts', params);
        return checkTaskArtifacts(params || ({} as CheckArtifactsParams));
    });

    rpcHandlerManager.registerHandler('task-write-artifact', async (params: WriteArtifactParams) => {
        logger.debug('[TASK RPC] task-write-artifact', params);
        return writeTaskArtifact(params || ({} as WriteArtifactParams));
    });

    rpcHandlerManager.registerHandler('task-read-artifact', async (params: ReadArtifactParams) => {
        logger.debug('[TASK RPC] task-read-artifact', params);
        return readTaskArtifact(params || ({} as ReadArtifactParams));
    });

    rpcHandlerManager.registerHandler('task-run-validation', async (params: RunValidationParams) => {
        logger.debug('[TASK RPC] task-run-validation', params);
        return runTaskValidation(params || ({} as RunValidationParams));
    });

    rpcHandlerManager.registerHandler('task-cleanup', async (params: CleanupTaskParams) => {
        logger.debug('[TASK RPC] task-cleanup', params);
        return cleanupTask(params || ({} as CleanupTaskParams));
    });
}
