/**
 * `task-deliver` and `task-cleanup` daemon RPCs (plan §8, milestone C0.4).
 *
 * Delivery is a deterministic daemon step, not an agent session: validate the
 * work branch prefix, push it, detect GitHub vs GitLab from the origin remote,
 * and open a PR/MR whose title and body come from `.happy-task/pr.md` (falling
 * back to `plan.md`'s first section, then the branch name). The external
 * `gh`/`glab` invocation is injectable so the git mechanics can be exercised
 * offline while the real CLI call ships for end-to-end acceptance.
 */
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '@/ui/logger';
import { currentBranch, runGit } from './taskGit';
import { TASK_BRANCH_PREFIX, TASK_ARTIFACT_DIR } from './prepareWorktree';

const execFileAsync = promisify(execFile);

export type GitPlatform = 'github' | 'gitlab';

export interface DeliverTaskParams {
    worktreePath: string;
    baseBranch: string;
    /** Override platform detection when the remote host is ambiguous (self-hosted). */
    platform?: GitPlatform;
}

export interface CreatePullRequestInput {
    platform: GitPlatform;
    worktreePath: string;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
}

export interface DeliverTaskDeps {
    /** Injectable PR/MR creation seam; defaults to the real gh/glab runner. */
    createPullRequest?: (input: CreatePullRequestInput) => Promise<{ url: string }>;
}

export interface DeliverTaskResult {
    prUrl: string;
    workBranch: string;
    platform: GitPlatform;
}

export interface PrContent {
    title: string;
    body: string;
}

/** Detect the hosting platform from an origin remote URL (host-substring match). */
export function detectGitPlatform(remoteUrl: string): GitPlatform | null {
    const host = extractRemoteHost(remoteUrl).toLowerCase();
    if (host.includes('github')) return 'github';
    if (host.includes('gitlab')) return 'gitlab';
    return null;
}

/** Extract the host from an ssh (`git@host:...`) or url (`scheme://host/...`) remote. */
export function extractRemoteHost(remoteUrl: string): string {
    const trimmed = remoteUrl.trim();
    const scpLike = /^[^/@]+@([^:]+):/.exec(trimmed);
    if (scpLike) return scpLike[1];
    try {
        return new URL(trimmed).hostname;
    } catch {
        return trimmed;
    }
}

/**
 * Resolve PR title/body from the hand-off artifacts. Priority: pr.md (first line
 * = title, remainder = body) → plan.md first section as title → branch name.
 */
export function resolvePrContent(input: { prMarkdown?: string; planMarkdown?: string; branch: string }): PrContent {
    const fromPr = parseTitleBody(input.prMarkdown);
    if (fromPr) return fromPr;
    const fromPlan = parseTitleBody(input.planMarkdown);
    if (fromPlan) return { title: fromPlan.title, body: '' };
    return { title: input.branch, body: '' };
}

function parseTitleBody(markdown?: string): PrContent | null {
    if (!markdown) return null;
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const titleIndex = lines.findIndex((line) => line.trim().length > 0);
    if (titleIndex === -1) return null;
    const title = lines[titleIndex].replace(/^#+\s*/, '').trim();
    if (title.length === 0) return null;
    const body = lines.slice(titleIndex + 1).join('\n').trim();
    return { title, body };
}

async function readIfExists(filePath: string): Promise<string | undefined> {
    if (!existsSync(filePath)) return undefined;
    return readFile(filePath, 'utf8');
}

async function createPullRequestViaCli(input: CreatePullRequestInput): Promise<{ url: string }> {
    if (input.platform === 'github') {
        const { stdout } = await execFileAsync(
            'gh',
            ['pr', 'create', '--base', input.baseBranch, '--head', input.headBranch, '--title', input.title, '--body', input.body],
            { cwd: input.worktreePath, maxBuffer: 8 * 1024 * 1024 },
        );
        return { url: stdout.toString().trim().split('\n').pop() ?? '' };
    }
    const { stdout } = await execFileAsync(
        'glab',
        ['mr', 'create', '--source-branch', input.headBranch, '--target-branch', input.baseBranch, '--title', input.title, '--description', input.body, '--yes'],
        { cwd: input.worktreePath, maxBuffer: 8 * 1024 * 1024 },
    );
    const url = stdout.toString().trim().split(/\s+/).find((token) => token.startsWith('http')) ?? '';
    return { url };
}

/**
 * Push the task branch and open a PR/MR. Rejects if the branch does not carry
 * the `happy/` prefix (guards against pushing straight onto a base branch).
 */
export async function deliverTask(params: DeliverTaskParams, deps?: DeliverTaskDeps): Promise<DeliverTaskResult> {
    const worktreePath = requireNonEmpty(params.worktreePath, 'worktreePath');
    const baseBranch = requireNonEmpty(params.baseBranch, 'baseBranch');
    if (!existsSync(worktreePath)) {
        throw new Error(`worktreePath does not exist: ${worktreePath}`);
    }

    const branch = await currentBranch(worktreePath);
    if (!branch.startsWith(TASK_BRANCH_PREFIX)) {
        throw new Error(`refusing to deliver: branch "${branch || '(detached)'}" is not a ${TASK_BRANCH_PREFIX} task branch`);
    }
    if (branch === baseBranch) {
        throw new Error(`refusing to deliver: work branch equals base branch "${baseBranch}"`);
    }

    const { stdout: remoteUrl } = await runGit(worktreePath, ['remote', 'get-url', 'origin']);
    const platform = params.platform ?? detectGitPlatform(remoteUrl);
    if (!platform) {
        throw new Error(`could not detect GitHub/GitLab from origin remote: ${remoteUrl.trim()}`);
    }

    await runGit(worktreePath, ['push', '-u', 'origin', branch]);

    const prMarkdown = await readIfExists(path.join(worktreePath, TASK_ARTIFACT_DIR, 'pr.md'));
    const planMarkdown = await readIfExists(path.join(worktreePath, TASK_ARTIFACT_DIR, 'plan.md'));
    const content = resolvePrContent({ prMarkdown, planMarkdown, branch });

    const createPr = deps?.createPullRequest ?? createPullRequestViaCli;
    const { url } = await createPr({
        platform,
        worktreePath,
        baseBranch,
        headBranch: branch,
        title: content.title,
        body: content.body,
    });

    logger.debug(`[TASK DELIVER] Delivered ${branch} to ${platform}: ${url}`);
    return { prUrl: url, workBranch: branch, platform };
}

export interface CleanupTaskParams {
    worktreePath: string;
    /** Keep the worktree in place (default true) so the member can cd in. */
    keepWorktree?: boolean;
}

export interface CleanupTaskResult {
    removed: boolean;
    worktreePath: string;
}

/**
 * Remove or retain the task worktree. Default keeps it (plan §8); the branch is
 * never touched. Idempotent when the worktree is already gone.
 */
export async function cleanupTask(params: CleanupTaskParams): Promise<CleanupTaskResult> {
    const worktreePath = requireNonEmpty(params.worktreePath, 'worktreePath');
    if (params.keepWorktree !== false) {
        return { removed: false, worktreePath };
    }
    if (!existsSync(worktreePath)) {
        return { removed: true, worktreePath };
    }
    await runGit(worktreePath, ['worktree', 'remove', '--force', worktreePath]);
    return { removed: true, worktreePath };
}

function requireNonEmpty(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}
