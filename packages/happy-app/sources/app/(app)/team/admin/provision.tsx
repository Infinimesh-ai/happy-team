import React from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Switch } from '@/components/Switch';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import {
    createProvisionJob,
    createSshCredential,
    createTeamEnrollToken,
    deleteSshCredential,
    listProvisionJobs,
    listSshCredentials,
    listTeamMachines,
    listTeamUsers,
    ProvisionAgent,
    ProvisionJob,
    retryProvisionJob,
    SshAuthType,
    SshCredential,
    TeamMachine,
    TeamUser,
} from '@/team/api';

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
    secretInput: {
        minHeight: 112,
        textAlignVertical: 'top',
        fontFamily: 'IBMPlexMono-Regular',
        fontSize: 13,
        lineHeight: 18,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    split: {
        flex: 1,
        gap: 8,
    },
    segment: {
        flex: 1,
        minHeight: 38,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 8,
    },
    segmentSelected: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.button.primary.background,
    },
    segmentText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 13,
    },
    segmentTextSelected: {
        color: theme.colors.button.primary.tint,
    },
    userButton: {
        minHeight: 44,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingHorizontal: 12,
        paddingVertical: 10,
        justifyContent: 'center',
    },
    userButtonSelected: {
        borderColor: theme.colors.button.primary.background,
        backgroundColor: theme.colors.input.background,
    },
    userTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 14,
    },
    userSubtitle: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 2,
    },
    toggleRow: {
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    toggleText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 15,
    },
    error: {
        ...Typography.default(),
        color: theme.colors.textDestructive,
        fontSize: 13,
        lineHeight: 18,
    },
    codeBlock: {
        ...Typography.default(),
        fontFamily: 'IBMPlexMono-Regular',
        backgroundColor: theme.colors.input.background,
        color: theme.colors.text,
        borderRadius: 8,
        padding: 12,
        fontSize: 12,
        lineHeight: 17,
    },
    logBlock: {
        ...Typography.default(),
        fontFamily: 'IBMPlexMono-Regular',
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 17,
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    empty: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 14,
        padding: 16,
    },
    iconButton: {
        width: 34,
        height: 34,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.input.background,
    },
}));

function Segment<T extends string>(props: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
    return (
        <View style={styles.row}>
            {props.options.map((option) => {
                const selected = option.value === props.value;
                return (
                    <Pressable
                        key={option.value}
                        onPress={() => props.onChange(option.value)}
                        style={[styles.segment, selected && styles.segmentSelected]}
                    >
                        <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{option.label}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

function ToggleRow(props: { label: string; value: boolean; onValueChange: (value: boolean) => void }) {
    return (
        <View style={styles.toggleRow}>
            <Text style={styles.toggleText}>{props.label}</Text>
            <Switch value={props.value} onValueChange={props.onValueChange} />
        </View>
    );
}

function statusLabel(job: ProvisionJob): string {
    if (job.status === 'SUCCEEDED') return t('team.provisionSucceeded');
    if (job.status === 'FAILED') return t('team.provisionFailed');
    if (job.status === 'RUNNING') return t('team.provisionRunning');
    return t('team.provisionPending');
}

export default function TeamProvisionScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [users, setUsers] = React.useState<TeamUser[]>([]);
    const [credentials, setCredentials] = React.useState<SshCredential[]>([]);
    const [machines, setMachines] = React.useState<TeamMachine[]>([]);
    const [jobs, setJobs] = React.useState<ProvisionJob[]>([]);
    const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);
    const [host, setHost] = React.useState('');
    const [port, setPort] = React.useState('22');
    const [username, setUsername] = React.useState('');
    const [authType, setAuthType] = React.useState<SshAuthType>('PASSWORD');
    const [secret, setSecret] = React.useState('');
    const [passphrase, setPassphrase] = React.useState('');
    const [deleteAfterUse, setDeleteAfterUse] = React.useState(true);
    const [claude, setClaude] = React.useState(true);
    const [codex, setCodex] = React.useState(false);
    const [manualCommand, setManualCommand] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [manualLoading, setManualLoading] = React.useState(false);
    const [deletingId, setDeletingId] = React.useState<string | null>(null);
    const [retryingId, setRetryingId] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    const selectedUser = React.useMemo(() => users.find((user) => user.id === selectedUserId) ?? null, [selectedUserId, users]);
    const agents = React.useMemo<ProvisionAgent[]>(() => {
        const values: ProvisionAgent[] = [];
        if (claude) values.push('claude');
        if (codex) values.push('codex');
        return values;
    }, [claude, codex]);

    const refresh = React.useCallback(async (showSpinner = true) => {
        if (!auth.credentials) {
            router.replace('/team/login');
            return;
        }
        if (showSpinner) setLoading(true);
        setError(null);
        try {
            const [usersResult, credentialsResult, jobsResult, machinesResult] = await Promise.all([
                listTeamUsers(auth.credentials),
                listSshCredentials(auth.credentials),
                listProvisionJobs(auth.credentials),
                listTeamMachines(auth.credentials),
            ]);
            setUsers(usersResult.users);
            setCredentials(credentialsResult.credentials);
            setJobs(jobsResult.jobs);
            setMachines(machinesResult.machines);
            setSelectedUserId((current) => current ?? usersResult.users[0]?.id ?? null);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.failedToLoadProvisioning'));
        } finally {
            if (showSpinner) setLoading(false);
        }
    }, [auth.credentials, router]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    React.useEffect(() => {
        if (!auth.credentials) return;
        const timer = setInterval(() => {
            listProvisionJobs(auth.credentials!)
                .then((result) => setJobs(result.jobs))
                .catch(() => {});
        }, 2500);
        return () => clearInterval(timer);
    }, [auth.credentials]);

    const startProvisioning = async () => {
        if (!auth.credentials || !selectedUser) return;
        const parsedPort = Number(port);
        if (!host.trim() || !username.trim() || !Number.isInteger(parsedPort) || parsedPort <= 0 || agents.length === 0) {
            setError(t('team.provisionValidationFailed'));
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const credential = await createSshCredential(auth.credentials, {
                ownerUserId: selectedUser.id,
                label: `${username}@${host}`,
                host: host.trim(),
                port: parsedPort,
                username: username.trim(),
                authType,
                password: authType === 'PASSWORD' ? secret : undefined,
                privateKey: authType === 'PRIVATE_KEY' ? secret : undefined,
                passphrase: authType === 'PRIVATE_KEY' && passphrase ? passphrase : undefined,
                deleteAfterUse,
            });
            const job = await createProvisionJob(auth.credentials, {
                credentialId: credential.credential.id,
                targetUserId: selectedUser.id,
                agents,
            });
            setManualCommand(job.manualCommand);
            await refresh(false);
            await Modal.alert(t('team.provisionStartedTitle'), t('team.provisionStartedMessage'));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.failedToStartProvisioning'));
        } finally {
            setSaving(false);
        }
    };

    const createManualCommand = async () => {
        if (!auth.credentials || !selectedUser || agents.length === 0) return;
        setManualLoading(true);
        setError(null);
        try {
            const result = await createTeamEnrollToken(auth.credentials, {
                targetUserId: selectedUser.id,
                agents,
            });
            setManualCommand(result.manualCommand);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.failedToCreateEnrollToken'));
        } finally {
            setManualLoading(false);
        }
    };

    const copyManualCommand = async () => {
        if (!manualCommand) return;
        await Clipboard.setStringAsync(manualCommand);
        await Modal.alert(t('common.copied'), t('team.manualCommandCopied'));
    };

    const removeCredential = async (credential: SshCredential) => {
        if (!auth.credentials) return;
        const confirmed = await Modal.confirm(t('team.deleteCredentialTitle'), t('team.deleteCredentialConfirm', { label: credential.label }), { confirmText: t('common.delete'), destructive: true });
        if (!confirmed) return;
        setDeletingId(credential.id);
        try {
            await deleteSshCredential(auth.credentials, credential.id);
            setCredentials((current) => current.filter((item) => item.id !== credential.id));
        } catch (e) {
            await Modal.alert(t('team.actionFailed'), e instanceof Error ? e.message : t('team.unableToUpdateMember'));
        } finally {
            setDeletingId(null);
        }
    };

    const retryJob = async (job: ProvisionJob) => {
        if (!auth.credentials) return;
        setRetryingId(job.id);
        setError(null);
        try {
            const result = await retryProvisionJob(auth.credentials, job.id);
            setManualCommand(result.manualCommand);
            await refresh(false);
            await Modal.alert(t('team.provisionStartedTitle'), t('team.provisionRetryStartedMessage'));
        } catch (e) {
            await Modal.alert(t('team.actionFailed'), e instanceof Error ? e.message : t('team.failedToRetryProvisioning'));
        } finally {
            setRetryingId(null);
        }
    };

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('team.provisionTitle') }} />
            <ItemList keyboardShouldPersistTaps="handled">
                <ItemGroup title={t('team.targetMember')}>
                    {loading ? (
                        <View style={styles.form}>
                            <ActivityIndicator />
                        </View>
                    ) : users.length === 0 ? (
                        <Text style={styles.empty}>{t('team.noMembersYet')}</Text>
                    ) : (
                        <View style={styles.form}>
                            {users.map((user) => {
                                const selected = selectedUserId === user.id;
                                const machineCount = machines.filter((machine) => machine.ownerUserId === user.id).length;
                                return (
                                    <Pressable
                                        key={user.id}
                                        onPress={() => setSelectedUserId(user.id)}
                                        style={[styles.userButton, selected && styles.userButtonSelected]}
                                    >
                                        <Text style={styles.userTitle}>{user.email}</Text>
                                        <Text style={styles.userSubtitle}>
                                            {t('team.userSubtitle', {
                                                role: user.role === 'ADMIN' ? t('team.adminRole') : t('team.memberRole'),
                                                status: user.status === 'ACTIVE' ? t('team.activeStatus') : t('team.disabledStatus'),
                                                count: machineCount,
                                            })}
                                        </Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    )}
                </ItemGroup>

                <ItemGroup title={t('team.sshDetails')}>
                    <View style={styles.form}>
                        <View style={styles.row}>
                            <View style={styles.split}>
                                <Text style={styles.label}>{t('team.host')}</Text>
                                <TextInput value={host} onChangeText={setHost} autoCapitalize="none" autoCorrect={false} style={styles.input} />
                            </View>
                            <View style={styles.split}>
                                <Text style={styles.label}>{t('team.port')}</Text>
                                <TextInput value={port} onChangeText={setPort} keyboardType="number-pad" style={styles.input} />
                            </View>
                        </View>
                        <Text style={styles.label}>{t('team.username')}</Text>
                        <TextInput value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} style={styles.input} />
                        <Text style={styles.label}>{t('team.authMethod')}</Text>
                        <Segment
                            value={authType}
                            options={[
                                { value: 'PASSWORD', label: t('team.passwordAuth') },
                                { value: 'PRIVATE_KEY', label: t('team.privateKeyAuth') },
                            ]}
                            onChange={setAuthType}
                        />
                        <Text style={styles.label}>{authType === 'PASSWORD' ? t('team.sshPassword') : t('team.privateKey')}</Text>
                        <TextInput
                            value={secret}
                            onChangeText={setSecret}
                            secureTextEntry={authType === 'PASSWORD'}
                            multiline={authType === 'PRIVATE_KEY'}
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={[styles.input, authType === 'PRIVATE_KEY' && styles.secretInput]}
                        />
                        {authType === 'PRIVATE_KEY' && (
                            <>
                                <Text style={styles.label}>{t('team.passphrase')}</Text>
                                <TextInput value={passphrase} onChangeText={setPassphrase} secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.input} />
                            </>
                        )}
                        <ToggleRow label={t('team.deleteCredentialAfterUse')} value={deleteAfterUse} onValueChange={setDeleteAfterUse} />
                    </View>
                </ItemGroup>

                <ItemGroup title={t('team.agents')}>
                    <View style={styles.form}>
                        <ToggleRow label={t('team.claudeCode')} value={claude} onValueChange={setClaude} />
                        <ToggleRow label={t('team.codex')} value={codex} onValueChange={setCodex} />
                        {error && <Text style={styles.error}>{error}</Text>}
                        <RoundButton title={t('team.startProvisioning')} size="normal" action={startProvisioning} loading={saving} disabled={!selectedUser || !secret.trim()} />
                        <RoundButton title={t('team.requestManualCommand')} size="normal" display="inverted" action={createManualCommand} loading={manualLoading} disabled={!selectedUser} />
                    </View>
                </ItemGroup>

                {manualCommand && (
                    <ItemGroup title={t('team.manualInstallCommand')}>
                        <View style={styles.form}>
                            <Text style={styles.codeBlock}>{manualCommand}</Text>
                            <RoundButton title={t('team.copyManualCommand')} size="normal" display="inverted" action={copyManualCommand} />
                        </View>
                    </ItemGroup>
                )}

                <ItemGroup title={t('team.savedCredentials')}>
                    {credentials.length === 0 ? (
                        <Text style={styles.empty}>{t('team.noSavedCredentials')}</Text>
                    ) : credentials.map((credential) => (
                        <Item
                            key={credential.id}
                            title={credential.label}
                            subtitle={`${credential.username}@${credential.host}:${credential.port} / ${credential.authType}`}
                            showChevron={false}
                            rightElement={(
                                <Pressable
                                    accessibilityLabel={t('team.deleteCredentialTitle')}
                                    disabled={deletingId === credential.id}
                                    onPress={() => void removeCredential(credential)}
                                    style={styles.iconButton}
                                >
                                    <Ionicons name="trash-outline" size={18} color={theme.colors.textDestructive} />
                                </Pressable>
                            )}
                        />
                    ))}
                </ItemGroup>

                <ItemGroup title={t('team.provisioningJobs')}>
                    {jobs.length === 0 ? (
                        <Text style={styles.empty}>{t('team.noProvisionJobs')}</Text>
                    ) : jobs.map((job) => (
                        <View key={job.id}>
                            <Item
                                title={statusLabel(job)}
                                subtitle={t('team.jobSubtitle', { step: job.step ?? '-', agents: job.agents.join(', ') || '-' })}
                                detail={job.error ?? job.machineId ?? undefined}
                                showChevron={false}
                                rightElement={job.status === 'FAILED' ? (
                                    <Pressable
                                        accessibilityLabel={t('team.retryProvisioning')}
                                        disabled={retryingId === job.id}
                                        onPress={() => void retryJob(job)}
                                        style={styles.iconButton}
                                    >
                                        <Ionicons name="refresh-outline" size={18} color={theme.colors.textSecondary} />
                                    </Pressable>
                                ) : undefined}
                            />
                            {job.log ? <Text style={styles.logBlock}>{job.log.trim()}</Text> : null}
                        </View>
                    ))}
                </ItemGroup>
            </ItemList>
        </>
    );
}
