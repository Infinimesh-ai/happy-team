import React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useAllMachines } from '@/sync/storage';
import { Machine } from '@/sync/storageTypes';
import { createTeamTask, listTeamTaskTemplates, TaskMode, TeamTaskTemplate } from '@/team/api';

function machineLabel(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id;
}

export default function NewTeamTaskScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const machines = useAllMachines({ includeOffline: true });

    const [templates, setTemplates] = React.useState<TeamTaskTemplate[]>([]);
    const [machineId, setMachineId] = React.useState<string | null>(null);
    const [templateId, setTemplateId] = React.useState<string | null>(null);
    const [mode, setMode] = React.useState<TaskMode>('SUPERVISED');
    const [title, setTitle] = React.useState('');
    const [repoPath, setRepoPath] = React.useState('');
    const [baseBranch, setBaseBranch] = React.useState('main');
    const [goalPrompt, setGoalPrompt] = React.useState('');
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        if (!auth.credentials) {
            router.replace('/team/login');
            return;
        }
        void (async () => {
            try {
                const result = await listTeamTaskTemplates(auth.credentials!);
                setTemplates(result.templates);
                if (result.templates.length > 0) setTemplateId(result.templates[0].id);
            } catch {
                // retry available; templates stay empty
            }
        })();
    }, [auth.credentials, router]);

    React.useEffect(() => {
        if (!machineId && machines.length > 0) setMachineId(machines[0].id);
    }, [machines, machineId]);

    const canSubmit = !!machineId && !!templateId && title.trim().length > 0
        && repoPath.trim().length > 0 && baseBranch.trim().length > 0 && goalPrompt.trim().length > 0;

    const submit = async () => {
        if (!auth.credentials || !machineId || !templateId) return;
        setLoading(true);
        try {
            await createTeamTask(auth.credentials, {
                machineId,
                templateId,
                mode,
                title: title.trim(),
                repoPath: repoPath.trim(),
                baseBranch: baseBranch.trim(),
                goalPrompt: goalPrompt.trim(),
            });
            router.replace('/team/tasks');
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : t('team.tasks.createFailed'), [{ text: t('common.ok') }]);
        } finally {
            setLoading(false);
        }
    };

    const selectRow = (selected: boolean, label: string, sublabel: string | undefined, onPress: () => void, key: string) => (
        <Pressable key={key} style={styles.selectRow} onPress={onPress}>
            <Ionicons
                name={selected ? 'radio-button-on' : 'radio-button-off'}
                size={22}
                color={selected ? theme.colors.status.connected : theme.colors.textSecondary}
            />
            <View style={styles.selectText}>
                <Text style={styles.selectLabel}>{label}</Text>
                {sublabel ? <Text style={styles.selectSub}>{sublabel}</Text> : null}
            </View>
        </Pressable>
    );

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('team.tasks.newTaskTitle') }} />
            <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <ItemList>
                    <ItemGroup title={t('team.tasks.machine')}>
                        <View style={styles.form}>
                            {machines.length === 0 ? (
                                <Text style={styles.sub}>{t('team.tasks.noMachines')}</Text>
                            ) : machines.map((m) => selectRow(
                                machineId === m.id,
                                machineLabel(m),
                                m.active ? t('status.online') : t('status.offline'),
                                () => setMachineId(m.id),
                                m.id,
                            ))}
                        </View>
                    </ItemGroup>

                    <ItemGroup title={t('team.tasks.template')}>
                        <View style={styles.form}>
                            {templates.map((tpl) => selectRow(
                                templateId === tpl.id,
                                tpl.id,
                                Object.keys(tpl.stages).join(' → '),
                                () => setTemplateId(tpl.id),
                                tpl.id,
                            ))}
                        </View>
                    </ItemGroup>

                    <ItemGroup title={t('team.tasks.mode')}>
                        <View style={styles.form}>
                            {selectRow(mode === 'SUPERVISED', t('team.tasks.supervised'), t('team.tasks.supervisedHint'), () => setMode('SUPERVISED'), 'sup')}
                            {selectRow(mode === 'AUTONOMOUS', t('team.tasks.autonomous'), t('team.tasks.autonomousHint'), () => setMode('AUTONOMOUS'), 'auto')}
                        </View>
                    </ItemGroup>

                    <ItemGroup title={t('team.tasks.details')}>
                        <View style={styles.form}>
                            <Text style={styles.label}>{t('team.tasks.titleLabel')}</Text>
                            <TextInput value={title} onChangeText={setTitle} placeholder={t('team.tasks.titlePlaceholder')} placeholderTextColor={theme.colors.input.placeholder} style={styles.input} />

                            <Text style={styles.label}>{t('team.tasks.repoPath')}</Text>
                            <TextInput value={repoPath} onChangeText={setRepoPath} placeholder={t('team.tasks.repoPathPlaceholder')} placeholderTextColor={theme.colors.input.placeholder} autoCapitalize="none" autoCorrect={false} style={styles.input} />

                            <Text style={styles.label}>{t('team.tasks.baseBranch')}</Text>
                            <TextInput value={baseBranch} onChangeText={setBaseBranch} placeholder="main" placeholderTextColor={theme.colors.input.placeholder} autoCapitalize="none" autoCorrect={false} style={styles.input} />

                            <Text style={styles.label}>{t('team.tasks.goal')}</Text>
                            <TextInput value={goalPrompt} onChangeText={setGoalPrompt} placeholder={t('team.tasks.goalPlaceholder')} placeholderTextColor={theme.colors.input.placeholder} multiline style={[styles.input, styles.multiline]} />

                            <RoundButton title={t('team.tasks.create')} action={submit} loading={loading} disabled={!canSubmit} style={styles.button} />
                        </View>
                    </ItemGroup>
                </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    flex: { flex: 1 },
    form: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
    },
    selectRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 6,
    },
    selectText: { flex: 1 },
    selectLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 15,
    },
    selectSub: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.textSecondary,
        fontSize: 12,
        textTransform: 'uppercase',
    },
    sub: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 14,
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
    multiline: {
        minHeight: 96,
        textAlignVertical: 'top',
    },
    button: {
        marginTop: 4,
    },
}));
