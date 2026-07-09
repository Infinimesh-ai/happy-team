import React from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';
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
import { t } from '@/text';
import { listTeamAudit, TeamAuditLog } from '@/team/api';

const styles = StyleSheet.create((theme) => ({
    form: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
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
    empty: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 14,
        padding: 16,
    },
}));

function formatDate(value: string): string {
    return new Date(value).toLocaleString();
}

function auditSubtitle(log: TeamAuditLog): string {
    return [
        formatDate(log.createdAt),
        log.actorId ? t('team.actor', { id: log.actorId }) : t('team.systemActor'),
        log.target ? t('team.target', { id: log.target }) : undefined,
    ].filter(Boolean).join(' / ');
}

export default function TeamAuditScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [logs, setLogs] = React.useState<TeamAuditLog[]>([]);
    const [action, setAction] = React.useState('');
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const load = React.useCallback(async (cursor?: string | null) => {
        if (!auth.credentials) {
            router.replace('/team/login');
            return;
        }
        cursor ? setLoadingMore(true) : setLoading(true);
        setError(null);
        try {
            const result = await listTeamAudit(auth.credentials, {
                limit: 50,
                cursor: cursor ?? undefined,
                action: action.trim() || undefined,
            });
            setLogs((current) => cursor ? [...current, ...result.logs] : result.logs);
            setNextCursor(result.nextCursor);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.failedToLoadAudit'));
        } finally {
            cursor ? setLoadingMore(false) : setLoading(false);
        }
    }, [action, auth.credentials, router]);

    React.useEffect(() => {
        void load(null);
    }, [load]);

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('team.auditTitle') }} />
            <ItemList keyboardShouldPersistTaps="handled">
                <ItemGroup title={t('team.filter')}>
                    <View style={styles.form}>
                        <TextInput
                            value={action}
                            onChangeText={setAction}
                            placeholder={t('team.actionFilterPlaceholder')}
                            placeholderTextColor={theme.colors.input.placeholder}
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={styles.input}
                        />
                        <RoundButton title={t('common.retry')} size="normal" display="inverted" action={() => load(null)} loading={loading} />
                    </View>
                </ItemGroup>
                <ItemGroup title={t('team.auditEvents')}>
                    {loading ? (
                        <View style={styles.form}>
                            <ActivityIndicator />
                        </View>
                    ) : error ? (
                        <Text style={styles.empty}>{error}</Text>
                    ) : logs.length === 0 ? (
                        <Text style={styles.empty}>{t('team.noAuditEvents')}</Text>
                    ) : logs.map((log) => (
                        <Item
                            key={log.id}
                            title={log.action}
                            subtitle={auditSubtitle(log)}
                            subtitleLines={2}
                            copy={JSON.stringify(log.detail ?? {}, null, 2)}
                            showChevron={false}
                            icon={<Ionicons name="receipt-outline" size={29} color={theme.colors.textSecondary} />}
                        />
                    ))}
                    {nextCursor && (
                        <Item
                            title={t('team.loadMore')}
                            onPress={() => void load(nextCursor)}
                            loading={loadingMore}
                            showChevron={false}
                            titleStyle={{ textAlign: 'center', color: theme.colors.textLink }}
                        />
                    )}
                </ItemGroup>
            </ItemList>
        </>
    );
}
