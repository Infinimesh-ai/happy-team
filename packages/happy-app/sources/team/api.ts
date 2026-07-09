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
}): Promise<{ user: TeamUser; temporaryPassword?: string }> {
    return teamRequest<{ user: TeamUser; temporaryPassword?: string }>(`/v1/team/admin/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials,
        body: input,
    });
}

export function listTeamMachines(credentials: AuthCredentials): Promise<{ machines: TeamMachine[] }> {
    return teamRequest<{ machines: TeamMachine[] }>('/v1/team/admin/machines', { credentials });
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

export function listProvisionJobs(credentials: AuthCredentials): Promise<{ jobs: ProvisionJob[] }> {
    return teamRequest<{ jobs: ProvisionJob[] }>('/v1/team/admin/provision-jobs', { credentials });
}

export function getProvisionJob(credentials: AuthCredentials, id: string): Promise<{ job: ProvisionJob }> {
    return teamRequest<{ job: ProvisionJob }>(`/v1/team/admin/provision-jobs/${encodeURIComponent(id)}`, { credentials });
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
