import { AuthCredentials } from '@/auth/tokenStorage';
import { getHappyClientId } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';

export type TeamRole = 'ADMIN' | 'MEMBER';
export type TeamUserStatus = 'ACTIVE' | 'DISABLED';
export type AgentAuthMode = 'COMPANY_API' | 'PERSONAL_OAUTH';

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
}): Promise<{ user: TeamUser; temporaryPassword?: string }> {
    return teamRequest<{ user: TeamUser; temporaryPassword?: string }>(`/v1/team/admin/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials,
        body: input,
    });
}
