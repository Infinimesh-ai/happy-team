import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
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
import { cancelTeamTask, listTeamTasks, TaskStatus, TeamTaskSummary } from '@/team/api';
import { taskStatusLabel } from '@/team/taskLabels';

const ACTIVE_STATUSES: TaskStatus[] = ['PENDING', 'PREPARING', 'RUNNING', 'WAITING_APPROVAL'];

function isActive(task: TeamTaskSummary): boolean {
    return ACTIVE_STATUSES.includes(task.status);
}

function statusColor(theme: ReturnType<typeof useUnistyles>['theme'], status: TaskStatus): string {
    if (status === 'SUCCEEDED') return theme.colors.status.connected;
    if (status === 'FAILED' || status === 'ESCALATED') return theme.colors.status.disconnected;
    if (status === 'CANCELLED') return theme.colors.textSecondary;
    return theme.colors.status.connecting;
}

function taskSubtitle(task: TeamTaskSummary): string {
    const parts = [taskStatusLabel(task.status)];
    if (task.currentStage) parts.push(t('team.tasks.stageLabel', { stage: task.currentStage }));
    if (task.status === 'FAILED' && task.error) parts.push(task.error);
    return parts.join(' · ');
}

export default function TeamTasksScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [tasks, setTasks] = React.useState<TeamTaskSummary[]>([]);
    const [loading, setLoading] = React.useState(true);

    const refresh = React.useCallback(async () => {
        if (!auth.credentials) {
            router.replace('/team/login');
            return;
        }
        setLoading(true);
        try {
            const result = await listTeamTasks(auth.credentials);
            setTasks(result.tasks);
        } catch {
            // Never surface a loading error — retry is available via the button.
        } finally {
            setLoading(false);
        }
    }, [auth.credentials, router]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const cancel = React.useCallback((task: TeamTaskSummary) => {
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
    }, [auth.credentials, refresh]);

    const openTask = React.useCallback((task: TeamTaskSummary) => {
        router.push(`/team/tasks/${task.id}`);
    }, [router]);

    const active = tasks.filter(isActive);
    const done = tasks.filter((task) => !isActive(task));

    const renderTask = (task: TeamTaskSummary) => (
        <Item
            key={task.id}
            title={task.title}
            subtitle={taskSubtitle(task)}
            subtitleLines={2}
            onPress={() => openTask(task)}
            icon={<Ionicons name="git-branch-outline" size={29} color={statusColor(theme, task.status)} />}
            rightElement={isActive(task) ? (
                <RoundButton title={t('common.cancel')} size="small" display="inverted" onPress={() => cancel(task)} />
            ) : undefined}
        />
    );

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('team.tasks.boardTitle') }} />
            <ItemList>
                <ItemGroup>
                    <View style={styles.actions}>
                        <RoundButton title={t('team.tasks.newTask')} onPress={() => router.push('/team/tasks/new')} />
                        <RoundButton title={t('common.retry')} size="normal" display="inverted" action={refresh} loading={loading} />
                    </View>
                </ItemGroup>

                <ItemGroup title={t('team.tasks.inProgress')}>
                    {loading && tasks.length === 0 ? (
                        <View style={styles.centered}><ActivityIndicator /></View>
                    ) : active.length === 0 ? (
                        <Text style={styles.empty}>{t('team.tasks.empty')}</Text>
                    ) : active.map(renderTask)}
                </ItemGroup>

                {done.length > 0 && (
                    <ItemGroup title={t('team.tasks.completed')}>
                        {done.map(renderTask)}
                    </ItemGroup>
                )}
            </ItemList>
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    actions: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
    },
    centered: {
        padding: 16,
        alignItems: 'center',
    },
    empty: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 14,
        padding: 16,
    },
}));
