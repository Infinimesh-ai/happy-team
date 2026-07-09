import React from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { AgentAuthMode, createTeamMember, listTeamUsers, TeamAgentAuthSync, TeamRole, TeamUser, updateTeamUser } from '@/team/api';

const styles = StyleSheet.create((theme) => ({
    form: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.textSecondary,
        fontSize: 12,
        textTransform: 'uppercase',
    },
    input: {
        ...Typography.default(),
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        fontSize: 16,
        minHeight: 44,
    },
    row: {
        flexDirection: 'row',
        gap: 8,
    },
    roleButton: {
        flex: 1,
        minHeight: 36,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        alignItems: 'center',
        justifyContent: 'center',
    },
    roleButtonSelected: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.button.primary.background,
    },
    roleText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 13,
    },
    roleTextSelected: {
        color: theme.colors.button.primary.tint,
    },
    error: {
        ...Typography.default(),
        color: theme.colors.textDestructive,
        fontSize: 13,
        lineHeight: 18,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    iconButton: {
        width: 34,
        height: 34,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.input.background,
    },
    empty: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 14,
        padding: 16,
    },
}));

function RoleSegment(props: { role: TeamRole; onChange: (role: TeamRole) => void }) {
    return (
        <View style={styles.row}>
            {(['MEMBER', 'ADMIN'] as const).map((role) => {
                const selected = props.role === role;
                return (
                    <Pressable
                        key={role}
                        onPress={() => props.onChange(role)}
                        style={[styles.roleButton, selected && styles.roleButtonSelected]}
                    >
                        <Text style={[styles.roleText, selected && styles.roleTextSelected]}>
                            {role === 'ADMIN' ? t('team.adminRole') : t('team.memberRole')}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

function UserActions(props: {
    user: TeamUser;
    busy: boolean;
    onAgentAuth: () => void;
    onDisable: () => void;
    onEnable: () => void;
    onReset: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.actions}>
            <Pressable
                accessibilityLabel={props.user.status === 'ACTIVE' ? t('team.disableUser') : t('team.enableUser')}
                disabled={props.busy}
                onPress={props.user.status === 'ACTIVE' ? props.onDisable : props.onEnable}
                style={styles.iconButton}
            >
                <Ionicons
                    name={props.user.status === 'ACTIVE' ? 'ban-outline' : 'checkmark-circle-outline'}
                    size={18}
                    color={props.user.status === 'ACTIVE' ? theme.colors.textDestructive : theme.colors.status.connected}
                />
            </Pressable>
            <Pressable
                accessibilityLabel={t('team.manageAgentAccess')}
                disabled={props.busy}
                onPress={props.onAgentAuth}
                style={styles.iconButton}
            >
                <Ionicons name="shield-checkmark-outline" size={18} color={theme.colors.textSecondary} />
            </Pressable>
            <Pressable
                accessibilityLabel={t('team.resetPassword')}
                disabled={props.busy}
                onPress={props.onReset}
                style={styles.iconButton}
            >
                <Ionicons name="key-outline" size={18} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
}

function nextMode(mode: AgentAuthMode): AgentAuthMode {
    return mode === 'COMPANY_API' ? 'PERSONAL_OAUTH' : 'COMPANY_API';
}

function modeLabel(mode: AgentAuthMode): string {
    return mode === 'COMPANY_API' ? t('team.companyApiMode') : t('team.personalOAuthMode');
}

function syncSummary(sync: TeamAgentAuthSync): string {
    return t('team.agentAuthSyncSummary', {
        applied: sync.applied,
        pending: sync.pending,
        failed: sync.failed,
    });
}

function mergeUpdatedUser(existing: TeamUser, updated: TeamUser): TeamUser {
    return {
        ...existing,
        ...updated,
        machineCount: updated.machineCount ?? existing.machineCount,
    };
}

export default function TeamAdminUsersScreen() {
    const auth = useAuth();
    const router = useRouter();
    const [users, setUsers] = React.useState<TeamUser[]>([]);
    const [email, setEmail] = React.useState('');
    const [role, setRole] = React.useState<TeamRole>('MEMBER');
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [busyUserId, setBusyUserId] = React.useState<string | null>(null);

    const refresh = React.useCallback(async () => {
        if (!auth.credentials) {
            router.replace('/team/login');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const result = await listTeamUsers(auth.credentials);
            setUsers(result.users);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.failedToLoadMembers'));
        } finally {
            setLoading(false);
        }
    }, [auth.credentials, router]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const createMember = async () => {
        if (!auth.credentials) return;
        setSaving(true);
        setError(null);
        try {
            const created = await createTeamMember(auth.credentials, { email, role });
            setUsers((current) => [...current, created.user]);
            setEmail('');
            setRole('MEMBER');
            await Modal.alert(t('team.memberCreatedTitle'), t('team.temporaryPassword', { password: created.initialPassword }));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.failedToCreateMember'));
        } finally {
            setSaving(false);
        }
    };

    const patchUser = async (user: TeamUser, action: 'disable' | 'enable' | 'reset') => {
        if (!auth.credentials) return;
        setBusyUserId(user.id);
        try {
            if (action === 'disable') {
                const confirmed = await Modal.confirm(t('team.disableMemberTitle'), t('team.disableMemberConfirm', { email: user.email }), { confirmText: t('team.disable'), destructive: true });
                if (!confirmed) return;
            }
            const result = await updateTeamUser(auth.credentials, user.id, action === 'reset'
                ? { resetPassword: true }
                : { status: action === 'disable' ? 'DISABLED' : 'ACTIVE' });
            setUsers((current) => current.map((item) => item.id === user.id ? mergeUpdatedUser(item, result.user) : item));
            if (result.temporaryPassword) {
                await Modal.alert(t('team.passwordResetTitle'), t('team.temporaryPassword', { password: result.temporaryPassword }));
            }
        } catch (e) {
            await Modal.alert(t('team.actionFailed'), e instanceof Error ? e.message : t('team.unableToUpdateMember'));
        } finally {
            setBusyUserId(null);
        }
    };

    const manageAgentAuth = async (user: TeamUser) => {
        if (!auth.credentials) return;
        setBusyUserId(user.id);
        try {
            const nextClaudeMode = nextMode(user.claudeAuthMode);
            const updateClaude = await Modal.confirm(
                t('team.agentAuthForMemberTitle', { email: user.email }),
                t('team.agentAuthSwitchConfirm', {
                    agent: t('team.claudeCode'),
                    mode: modeLabel(nextClaudeMode),
                    email: user.email,
                }),
                {
                    cancelText: t('team.agentAuthKeepCurrent'),
                    confirmText: t('team.agentAuthSwitchTo', { mode: modeLabel(nextClaudeMode) }),
                },
            );

            const nextCodexMode = nextMode(user.codexAuthMode);
            const updateCodex = await Modal.confirm(
                t('team.agentAuthForMemberTitle', { email: user.email }),
                t('team.agentAuthSwitchConfirm', {
                    agent: t('team.codex'),
                    mode: modeLabel(nextCodexMode),
                    email: user.email,
                }),
                {
                    cancelText: t('team.agentAuthKeepCurrent'),
                    confirmText: t('team.agentAuthSwitchTo', { mode: modeLabel(nextCodexMode) }),
                },
            );

            const input: { claudeAuthMode?: AgentAuthMode; codexAuthMode?: AgentAuthMode } = {};
            if (updateClaude) input.claudeAuthMode = nextClaudeMode;
            if (updateCodex) input.codexAuthMode = nextCodexMode;
            if (!input.claudeAuthMode && !input.codexAuthMode) {
                return;
            }

            const result = await updateTeamUser(auth.credentials, user.id, input);
            setUsers((current) => current.map((item) => item.id === user.id ? mergeUpdatedUser(item, result.user) : item));
            if (result.agentAuthSync) {
                await Modal.alert(t('team.agentAuthUpdatedTitle'), syncSummary(result.agentAuthSync));
            }
        } catch (e) {
            await Modal.alert(t('team.actionFailed'), e instanceof Error ? e.message : t('team.failedToUpdateAgentAuth'));
        } finally {
            setBusyUserId(null);
        }
    };

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('team.membersTitle') }} />
            <ItemList keyboardShouldPersistTaps="handled">
                <ItemGroup title={t('team.createMember')}>
                    <View style={styles.form}>
                        <Text style={styles.label}>{t('team.email')}</Text>
                        <TextInput
                            value={email}
                            onChangeText={setEmail}
                            placeholder={t('team.emailPlaceholder')}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="email-address"
                            style={styles.input}
                        />
                        <Text style={styles.label}>{t('team.role')}</Text>
                        <RoleSegment role={role} onChange={setRole} />
                        {error && <Text style={styles.error}>{error}</Text>}
                        <RoundButton
                            title={t('team.createMember')}
                            size="normal"
                            action={createMember}
                            loading={saving}
                            disabled={!email.trim()}
                        />
                    </View>
                </ItemGroup>

                <ItemGroup title={t('team.administration')}>
                    <Item
                        title={t('team.machinesTitle')}
                        subtitle={t('team.machinesSubtitle')}
                        onPress={() => router.push('/team/admin/machines')}
                    />
                    <Item
                        title={t('team.auditTitle')}
                        subtitle={t('team.auditSubtitle')}
                        onPress={() => router.push('/team/admin/audit')}
                    />
                    <Item
                        title={t('team.provisionMachine')}
                        subtitle={t('team.provisionMachineSubtitle')}
                        onPress={() => router.push('/team/admin/provision')}
                    />
                    <Item
                        title={t('team.preflightTitle')}
                        subtitle={t('team.preflightSubtitle')}
                        onPress={() => router.push('/team/admin/preflight')}
                    />
                </ItemGroup>

                <ItemGroup title={t('team.members')}>
                    {loading ? (
                        <View style={styles.form}>
                            <ActivityIndicator />
                        </View>
                    ) : users.length === 0 ? (
                        <Text style={styles.empty}>{t('team.noMembersYet')}</Text>
                    ) : users.map((user) => (
                        <Item
                            key={user.id}
                            title={user.email}
                            subtitle={t('team.userSubtitle', {
                                role: user.role === 'ADMIN' ? t('team.adminRole') : t('team.memberRole'),
                                status: user.status === 'ACTIVE' ? t('team.activeStatus') : t('team.disabledStatus'),
                                count: user.machineCount ?? 0,
                            }) + '\n' + t('team.userAgentAuthSubtitle', {
                                claude: modeLabel(user.claudeAuthMode),
                                codex: modeLabel(user.codexAuthMode),
                            })}
                            subtitleLines={2}
                            detail={user.mustChangePassword ? t('team.mustChangePassword') : undefined}
                            showChevron={false}
                            rightElement={(
                                <UserActions
                                    user={user}
                                    busy={busyUserId === user.id}
                                    onAgentAuth={() => void manageAgentAuth(user)}
                                    onDisable={() => void patchUser(user, 'disable')}
                                    onEnable={() => void patchUser(user, 'enable')}
                                    onReset={() => void patchUser(user, 'reset')}
                                />
                            )}
                        />
                    ))}
                </ItemGroup>
            </ItemList>
        </>
    );
}
