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
import { AgentAuthMode, getTeamMe, TeamAgentAuthSync, updateMyAgentAuth } from '@/team/api';

const styles = StyleSheet.create((theme) => ({
    form: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
    },
    empty: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 14,
        padding: 16,
    },
}));

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

export default function TeamAgentAuthScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [claudeAuthMode, setClaudeAuthMode] = React.useState<AgentAuthMode>('COMPANY_API');
    const [codexAuthMode, setCodexAuthMode] = React.useState<AgentAuthMode>('COMPANY_API');
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [lastSync, setLastSync] = React.useState<TeamAgentAuthSync | null>(null);

    const refresh = React.useCallback(async () => {
        if (!auth.credentials) {
            router.replace('/team/login');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const result = await getTeamMe(auth.credentials);
            setClaudeAuthMode(result.user.claudeAuthMode);
            setCodexAuthMode(result.user.codexAuthMode);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.failedToLoadAgentAuth'));
        } finally {
            setLoading(false);
        }
    }, [auth.credentials, router]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const save = async () => {
        if (!auth.credentials) return;
        setSaving(true);
        setError(null);
        try {
            const result = await updateMyAgentAuth(auth.credentials, {
                claudeAuthMode,
                codexAuthMode,
            });
            setLastSync(result.agentAuthSync);
            await Modal.alert(t('team.agentAuthUpdatedTitle'), syncSummary(result.agentAuthSync));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.failedToUpdateAgentAuth'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('team.agentAuthTitle') }} />
            <ItemList>
                <ItemGroup title={t('team.agents')}>
                    {loading ? (
                        <View style={styles.form}>
                            <ActivityIndicator />
                        </View>
                    ) : (
                        <>
                            <Item
                                title={t('team.claudeCode')}
                                subtitle={t('team.agentAuthModeSubtitle')}
                                detail={modeLabel(claudeAuthMode)}
                                icon={<Ionicons name="terminal-outline" size={29} color={theme.colors.textSecondary} />}
                                onPress={() => setClaudeAuthMode(nextMode)}
                            />
                            <Item
                                title={t('team.codex')}
                                subtitle={t('team.agentAuthModeSubtitle')}
                                detail={modeLabel(codexAuthMode)}
                                icon={<Ionicons name="code-slash-outline" size={29} color={theme.colors.textSecondary} />}
                                onPress={() => setCodexAuthMode(nextMode)}
                            />
                        </>
                    )}
                </ItemGroup>
                <ItemGroup>
                    <View style={styles.form}>
                        {error && <Text style={styles.empty}>{error}</Text>}
                        {lastSync && <Text style={styles.empty}>{syncSummary(lastSync)}</Text>}
                        <RoundButton title={t('common.save')} size="normal" action={save} loading={saving} disabled={loading} />
                    </View>
                </ItemGroup>
            </ItemList>
        </>
    );
}
