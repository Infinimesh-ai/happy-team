import React from 'react';
import { ActivityIndicator, Linking, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { approveTeamTask, cancelTeamTask, getTeamTask, getTeamTaskPlan, rejectTeamTask, TaskStatus, TeamTaskDetail } from '@/team/api';
import { taskStatusLabel } from '@/team/taskLabels';

const ACTIVE_STATUSES: TaskStatus[] = ['PENDING', 'PREPARING', 'RUNNING', 'WAITING_APPROVAL'];

function statusColor(theme: ReturnType<typeof useUnistyles>['theme'], status: TaskStatus): string {
    if (status === 'SUCCEEDED') return theme.colors.status.connected;
    if (status === 'FAILED' || status === 'ESCALATED') return theme.colors.status.disconnected;
    if (status === 'CANCELLED') return theme.colors.textSecondary;
    return theme.colors.status.connecting;
}

export default function TeamTaskDetailScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const { id } = useLocalSearchParams<{ id: string }>();
    const [task, setTask] = React.useState<TeamTaskDetail | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [plan, setPlan] = React.useState('');
    const [planLoaded, setPlanLoaded] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);

    const refresh = React.useCallback(async () => {
        if (!auth.credentials) {
            router.replace('/team/login');
            return;
        }
        if (!id) return;
        setLoading(true);
        try {
            const result = await getTeamTask(auth.credentials, id);
            setTask(result.task);
        } catch {
            // Never surface a loading error — retry via the button.
        } finally {
            setLoading(false);
        }
    }, [auth.credentials, id, router]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    // Load plan.md once the task is awaiting approval (for the approval card).
    React.useEffect(() => {
        if (task?.status !== 'WAITING_APPROVAL' || planLoaded || !auth.credentials || !id) return;
        void (async () => {
            try {
                const result = await getTeamTaskPlan(auth.credentials!, id);
                setPlan(result.plan ?? '');
            } catch {
                // leave plan empty; the card still allows approve/reject
            } finally {
                setPlanLoaded(true);
            }
        })();
    }, [task?.status, planLoaded, auth.credentials, id]);

    const approve = React.useCallback((withEdits: boolean) => {
        if (!auth.credentials || !id) return;
        setSubmitting(true);
        void (async () => {
            try {
                await approveTeamTask(auth.credentials!, id, withEdits ? plan : undefined);
            } catch (e) {
                Modal.alert(t('common.error'), e instanceof Error ? e.message : t('team.tasks.createFailed'), [{ text: t('common.ok') }]);
            } finally {
                setSubmitting(false);
                setPlanLoaded(false);
                void refresh();
            }
        })();
    }, [auth.credentials, id, plan, refresh]);

    const reject = React.useCallback(() => {
        if (!auth.credentials || !id) return;
        Modal.alert(t('team.tasks.reject'), t('team.tasks.rejectConfirm'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('team.tasks.reject'),
                style: 'destructive',
                onPress: async () => {
                    try {
                        await rejectTeamTask(auth.credentials!, id);
                    } finally {
                        void refresh();
                    }
                },
            },
        ]);
    }, [auth.credentials, id, refresh]);

    const cancel = React.useCallback(() => {
        if (!task) return;
        Modal.alert(t('team.tasks.cancelTask'), t('team.tasks.cancelConfirm', { title: task.title }), [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('team.tasks.cancelTask'),
                style: 'destructive',
                onPress: async () => {
                    if (!auth.credentials) return;
                    try {
                        await cancelTeamTask(auth.credentials, task.id);
                    } finally {
                        void refresh();
                    }
                },
            },
        ]);
    }, [auth.credentials, task, refresh]);

    if (loading && !task) {
        return (
            <>
                <Stack.Screen options={{ headerShown: true, headerTitle: t('team.tasks.detailTitle') }} />
                <View style={styles.centered}><ActivityIndicator /></View>
            </>
        );
    }
    if (!task) {
        return (
            <>
                <Stack.Screen options={{ headerShown: true, headerTitle: t('team.tasks.detailTitle') }} />
                <ItemList><Text style={styles.empty}>{t('team.tasks.notFound')}</Text></ItemList>
            </>
        );
    }

    const isActive = ACTIVE_STATUSES.includes(task.status);

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: task.title }} />
            <ItemList>
                <ItemGroup title={t('team.tasks.overview')}>
                    <Item
                        title={taskStatusLabel(task.status)}
                        subtitle={task.currentStage ? t('team.tasks.stageLabel', { stage: task.currentStage }) : undefined}
                        icon={<Ionicons name="ellipse" size={16} color={statusColor(theme, task.status)} />}
                        showChevron={false}
                    />
                    <Item title={t('team.tasks.branch')} subtitle={task.workBranch} copy={task.workBranch} showChevron={false} />
                    <Item title={t('team.tasks.repoPath')} subtitle={task.repoPath} showChevron={false} />
                    {task.round > 0 && (
                        <Item title={t('team.tasks.round')} subtitle={`${task.round} / ${task.maxRounds}`} showChevron={false} />
                    )}
                    {task.error && <Item title={t('team.tasks.error')} subtitle={task.error} subtitleLines={4} showChevron={false} />}
                </ItemGroup>

                <ItemGroup title={t('team.tasks.goal')}>
                    <View style={styles.block}><Text style={styles.body}>{task.goalPrompt}</Text></View>
                </ItemGroup>

                {task.status === 'WAITING_APPROVAL' && (
                    <ItemGroup title={t('team.tasks.approvalTitle')}>
                        <View style={styles.block}>
                            <Text style={styles.sub}>{t('team.tasks.approvalHint')}</Text>
                            <TextInput
                                value={plan}
                                onChangeText={setPlan}
                                editable={planLoaded && !submitting}
                                multiline
                                style={[styles.input, styles.planInput]}
                                placeholder={planLoaded ? undefined : t('team.tasks.loadingPlan')}
                                placeholderTextColor={theme.colors.input.placeholder}
                            />
                            <RoundButton title={t('team.tasks.approve')} action={async () => approve(false)} loading={submitting} />
                            <RoundButton title={t('team.tasks.approveEdited')} display="inverted" size="normal" onPress={() => approve(true)} disabled={submitting} />
                            <RoundButton title={t('team.tasks.reject')} display="inverted" size="normal" onPress={reject} disabled={submitting} />
                        </View>
                    </ItemGroup>
                )}

                {task.prUrl && (
                    <ItemGroup>
                        <View style={styles.block}>
                            <RoundButton title={t('team.tasks.viewPr')} action={() => Linking.openURL(task.prUrl!)} />
                        </View>
                    </ItemGroup>
                )}

                <ItemGroup title={t('team.tasks.stages')}>
                    {task.stageRuns.length === 0 ? (
                        <Text style={styles.empty}>{t('team.tasks.noStages')}</Text>
                    ) : task.stageRuns.map((run) => (
                        <Item
                            key={run.id}
                            title={`${run.stage} · ${run.agent}`}
                            subtitle={taskStatusLabel(run.status)}
                            detail={run.model ?? undefined}
                            onPress={run.sessionId ? () => router.push(`/session/${run.sessionId}`) : undefined}
                            showChevron={!!run.sessionId}
                        />
                    ))}
                </ItemGroup>

                <ItemGroup>
                    <View style={styles.block}>
                        <RoundButton title={t('common.retry')} size="normal" display="inverted" action={refresh} loading={loading} />
                        {isActive && (
                            <RoundButton title={t('team.tasks.cancelTask')} size="normal" display="inverted" onPress={cancel} />
                        )}
                    </View>
                </ItemGroup>
            </ItemList>
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    block: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
    },
    body: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 21,
    },
    sub: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    input: {
        ...Typography.default(),
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        fontSize: 15,
    },
    planInput: {
        minHeight: 160,
        textAlignVertical: 'top',
    },
    empty: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 14,
        padding: 16,
    },
}));
