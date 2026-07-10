import { AuthCredentials } from '@/auth/tokenStorage';
import { getHappyClientId } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';

export type TeamRole = 'ADMIN' | 'MEMBER';
export type TeamUserStatus = 'ACTIVE' | 'DISABLED';
export type AgentAuthMode = 'COMPANY_API' | 'PERSONAL_OAUTH';
export type SshAuthType = 'PASSWORD' | 'PRIVATE_KEY';
export type ProvisionStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type ProvisionAgent = 'claude' | 'codex';

export interface TeamUser {
    id: string;
    email: string;
    role: TeamRole;
    status: TeamUserStatus;
    mustChangePassword: boolean;
    accountId: string;
    claudeAuthMode: AgentAuthMode;
    codexAuthMode: AgentAuthMode;
    machineCount?: number;
    createdAt: string;
    updatedAt: string;
}

export interface TeamLoginResponse {
    happyToken: string;
    secretKey: string;
    role: TeamRole;
    mustChangePassword: boolean;
}

export interface TeamMachine {
    id: string;
    accountId: string;
    ownerUserId: string | null;
    ownerEmail: string | null;
    active: boolean;
    activeAt: number;
    createdAt: string;
    updatedAt: string;
}

export interface SshCredential {
    id: string;
    ownerUserId: string;
    label: string;
    host: string;
    port: number;
    username: string;
    authType: SshAuthType;
    deleteAfterUse: boolean;
    createdBy: string;
    createdAt: string;
}

export interface ProvisionJob {
    id: string;
    credentialId: string | null;
    hostSnapshot: string;
    targetUserId: string;
    agents: ProvisionAgent[];
    status: ProvisionStatus;
    step: string | null;
    log: string;
    machineId: string | null;
    error: string | null;
    createdBy: string;
    createdAt: string;
    finishedAt: string | null;
}

export interface TeamAuditLog {
    id: string;
    actorId: string | null;
    action: string;
    target: string | null;
    detail: unknown;
    createdAt: string;
}

export interface TeamAgentAuthSync {
    totalMachines: number;
    applied: number;
    pending: number;
    failed: number;
    machines: Array<{
        machineId: string;
        status: 'PENDING' | 'APPLIED' | 'FAILED';
        error?: string;
    }>;
}

export interface TeamAgentAuthStatus extends TeamAgentAuthSync {
    machines: Array<TeamAgentAuthSync['machines'][number] & {
        claudeAuthMode: AgentAuthMode;
        codexAuthMode: AgentAuthMode;
        active: boolean;
        activeAt: number;
        appliedAt: string | null;
        updatedAt: string | null;
    }>;
}

export type TeamPreflightStatus = 'ok' | 'warning' | 'action_required';

export interface TeamPreflightCheck {
    key: string;
    status: TeamPreflightStatus;
    message: string;
    detail?: Record<string, string | number | boolean | null>;
}

export interface TeamDeploymentPreflight {
    status: TeamPreflightStatus;
    checkedAt: string;
    serverUrl: string;
    checks: TeamPreflightCheck[];
}

async function readResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
        throw new Error(body.error || `Request failed with ${response.status}`);
    }
    return body as T;
}

async function teamRequest<T>(path: string, options: {
    method?: string;
    body?: unknown;
    credentials?: AuthCredentials | null;
} = {}): Promise<T> {
    const headers: Record<string, string> = {
        'Accept': 'application/json',
        'X-Happy-Client': getHappyClientId(),
    };
    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }
    if (options.credentials) {
        headers.Authorization = `Bearer ${options.credentials.token}`;
    }

    const response = await fetch(`${getServerUrl()}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return readResponse<T>(response);
}

export function loginTeam(email: string, password: string): Promise<TeamLoginResponse> {
    return teamRequest<TeamLoginResponse>('/v1/team/auth/login', {
        method: 'POST',
        body: { email, password },
    });
}

export function changeTeamPassword(credentials: AuthCredentials, oldPassword: string, newPassword: string): Promise<{ success: true }> {
    return teamRequest<{ success: true }>('/v1/team/auth/change-password', {
        method: 'POST',
        credentials,
        body: { oldPassword, newPassword },
    });
}

export function getTeamMe(credentials: AuthCredentials): Promise<{ user: TeamUser }> {
    return teamRequest<{ user: TeamUser }>('/v1/team/me', { credentials });
}

export function getMyAgentAuth(credentials: AuthCredentials): Promise<{ user: TeamUser; agentAuthStatus: TeamAgentAuthStatus }> {
    return teamRequest<{ user: TeamUser; agentAuthStatus: TeamAgentAuthStatus }>('/v1/team/me/agent-auth', { credentials });
}

export function listTeamUsers(credentials: AuthCredentials): Promise<{ users: TeamUser[] }> {
    return teamRequest<{ users: TeamUser[] }>('/v1/team/admin/users', { credentials });
}

export function createTeamMember(credentials: AuthCredentials, input: { email: string; role: TeamRole; password?: string }): Promise<{ user: TeamUser; initialPassword: string }> {
    return teamRequest<{ user: TeamUser; initialPassword: string }>('/v1/team/admin/users', {
        method: 'POST',
        credentials,
        body: input,
    });
}

export function updateTeamUser(credentials: AuthCredentials, id: string, input: {
    status?: TeamUserStatus;
    role?: TeamRole;
    resetPassword?: boolean;
    claudeAuthMode?: AgentAuthMode;
    codexAuthMode?: AgentAuthMode;
}): Promise<{ user: TeamUser; temporaryPassword?: string; agentAuthSync?: TeamAgentAuthSync }> {
    return teamRequest<{ user: TeamUser; temporaryPassword?: string; agentAuthSync?: TeamAgentAuthSync }>(`/v1/team/admin/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials,
        body: input,
    });
}

export function updateMyAgentAuth(credentials: AuthCredentials, input: {
    claudeAuthMode?: AgentAuthMode;
    codexAuthMode?: AgentAuthMode;
}): Promise<{ user: TeamUser; agentAuthSync: TeamAgentAuthSync }> {
    return teamRequest<{ user: TeamUser; agentAuthSync: TeamAgentAuthSync }>('/v1/team/me/agent-auth', {
        method: 'PATCH',
        credentials,
        body: input,
    });
}

export function listTeamMachines(credentials: AuthCredentials): Promise<{ machines: TeamMachine[] }> {
    return teamRequest<{ machines: TeamMachine[] }>('/v1/team/admin/machines', { credentials });
}

export function listTeamAudit(credentials: AuthCredentials, input: { limit?: number; cursor?: string; action?: string } = {}): Promise<{ logs: TeamAuditLog[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    if (input.limit) params.set('limit', String(input.limit));
    if (input.cursor) params.set('cursor', input.cursor);
    if (input.action) params.set('action', input.action);
    const query = params.toString();
    return teamRequest<{ logs: TeamAuditLog[]; nextCursor: string | null }>(`/v1/team/admin/audit${query ? `?${query}` : ''}`, { credentials });
}

export function getTeamPreflight(credentials: AuthCredentials): Promise<TeamDeploymentPreflight> {
    return teamRequest<TeamDeploymentPreflight>('/v1/team/admin/preflight', { credentials });
}

export function listSshCredentials(credentials: AuthCredentials): Promise<{ credentials: SshCredential[] }> {
    return teamRequest<{ credentials: SshCredential[] }>('/v1/team/admin/ssh-credentials', { credentials });
}

export function createSshCredential(credentials: AuthCredentials, input: {
    ownerUserId: string;
    label: string;
    host: string;
    port: number;
    username: string;
    authType: SshAuthType;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    deleteAfterUse: boolean;
}): Promise<{ credential: SshCredential }> {
    return teamRequest<{ credential: SshCredential }>('/v1/team/admin/ssh-credentials', {
        method: 'POST',
        credentials,
        body: input,
    });
}

export function deleteSshCredential(credentials: AuthCredentials, id: string): Promise<{ success: true }> {
    return teamRequest<{ success: true }>(`/v1/team/admin/ssh-credentials/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials,
    });
}

export function listProvisionJobs(credentials: AuthCredentials): Promise<{ jobs: ProvisionJob[]; queue?: { activeJobs: number; pendingJobs: number } }> {
    return teamRequest<{ jobs: ProvisionJob[]; queue?: { activeJobs: number; pendingJobs: number } }>('/v1/team/admin/provision-jobs', { credentials });
}

export function getProvisionJob(credentials: AuthCredentials, id: string): Promise<{ job: ProvisionJob; queue?: { activeJobs: number; pendingJobs: number } }> {
    return teamRequest<{ job: ProvisionJob; queue?: { activeJobs: number; pendingJobs: number } }>(`/v1/team/admin/provision-jobs/${encodeURIComponent(id)}`, { credentials });
}

export function createProvisionJob(credentials: AuthCredentials, input: {
    credentialId: string;
    targetUserId: string;
    agents: ProvisionAgent[];
}): Promise<{ job: ProvisionJob; enrollToken: { id: string; token: string; expiresAt: string }; manualCommand: string }> {
    return teamRequest<{ job: ProvisionJob; enrollToken: { id: string; token: string; expiresAt: string }; manualCommand: string }>('/v1/team/admin/provision-jobs', {
        method: 'POST',
        credentials,
        body: input,
    });
}

export function retryProvisionJob(credentials: AuthCredentials, id: string): Promise<{ job: ProvisionJob; enrollToken: { id: string; token: string; expiresAt: string }; manualCommand: string }> {
    return teamRequest<{ job: ProvisionJob; enrollToken: { id: string; token: string; expiresAt: string }; manualCommand: string }>(`/v1/team/admin/provision-jobs/${encodeURIComponent(id)}/retry`, {
        method: 'POST',
        credentials,
    });
}

export function createTeamEnrollToken(credentials: AuthCredentials, input: {
    targetUserId: string;
    agents: ProvisionAgent[];
}): Promise<{ id: string; token: string; expiresAt: string; manualCommand: string }> {
    return teamRequest<{ id: string; token: string; expiresAt: string; manualCommand: string }>('/v1/team/admin/enroll-token', {
        method: 'POST',
        credentials,
        body: input,
    });
}

// Cloud-agent tasks (plan §10.1) ------------------------------------------------

export type TaskMode = 'SUPERVISED' | 'AUTONOMOUS';
export type TaskStatus =
    | 'PENDING' | 'PREPARING' | 'RUNNING' | 'WAITING_APPROVAL'
    | 'SUCCEEDED' | 'FAILED' | 'ESCALATED' | 'CANCELLED';
export type TaskStageRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface TeamTaskSummary {
    id: string;
    title: string;
    templateId: string;
    mode: TaskMode;
    status: TaskStatus;
    machineId: string;
    repoPath: string;
    baseBranch: string;
    workBranch: string;
    currentStage: string | null;
    round: number;
    maxRounds: number;
    prUrl: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
}

export interface TeamTaskStageRun {
    id: string;
    stage: string;
    round: number;
    agent: string;
    model: string | null;
    sessionId: string | null;
    status: TaskStageRunStatus;
    summary: string | null;
    startedAt: string;
    endedAt: string | null;
}

export interface TeamTaskTransition {
    id: string;
    fromStage: string | null;
    toStage: string;
    requestedBy: string;
    reason: string | null;
    decision: string;
    decidedBy: string | null;
    createdAt: string;
}

export interface TeamTaskDetail extends TeamTaskSummary {
    goalPrompt: string;
    worktreePath: string | null;
    skillsCommit: string | null;
    stageRuns: TeamTaskStageRun[];
    transitions: TeamTaskTransition[];
}

export interface TeamTaskTemplateStage {
    agent: string;
    model: string | null;
    permissionMode: string;
    expectedArtifacts: string[];
}

export interface TeamTaskTemplate {
    id: string;
    stages: Record<string, TeamTaskTemplateStage>;
    transitions: { from: string | null; to: string; requiresApproval?: boolean; condition?: string }[];
}

export interface CreateTeamTaskInput {
    machineId: string;
    repoPath: string;
    templateId: string;
    mode: TaskMode;
    title: string;
    goalPrompt: string;
    baseBranch: string;
}

export function listTeamTasks(credentials: AuthCredentials): Promise<{ tasks: TeamTaskSummary[] }> {
    return teamRequest<{ tasks: TeamTaskSummary[] }>('/v1/team/tasks', { credentials });
}

export function getTeamTask(credentials: AuthCredentials, id: string): Promise<{ task: TeamTaskDetail }> {
    return teamRequest<{ task: TeamTaskDetail }>(`/v1/team/tasks/${encodeURIComponent(id)}`, { credentials });
}

export function createTeamTask(credentials: AuthCredentials, input: CreateTeamTaskInput): Promise<{ task: TeamTaskDetail }> {
    return teamRequest<{ task: TeamTaskDetail }>('/v1/team/tasks', {
        method: 'POST',
        credentials,
        body: input,
    });
}

export function cancelTeamTask(credentials: AuthCredentials, id: string): Promise<{ task: TeamTaskSummary }> {
    return teamRequest<{ task: TeamTaskSummary }>(`/v1/team/tasks/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        credentials,
    });
}

export function listTeamTaskTemplates(credentials: AuthCredentials): Promise<{ templates: TeamTaskTemplate[] }> {
    return teamRequest<{ templates: TeamTaskTemplate[] }>('/v1/team/tasks/templates', { credentials });
}
