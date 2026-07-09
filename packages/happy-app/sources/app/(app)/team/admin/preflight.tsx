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
import { t } from '@/text';
import { getTeamPreflight, TeamDeploymentPreflight, TeamPreflightCheck, TeamPreflightStatus } from '@/team/api';

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

function formatDate(value: string): string {
    return new Date(value).toLocaleString();
}

function statusLabel(status: TeamPreflightStatus): string {
    switch (status) {
        case 'ok':
            return t('team.preflightOk');
        case 'warning':
            return t('team.preflightWarning');
        case 'action_required':
            return t('team.preflightActionRequired');
    }
}

function statusIcon(status: TeamPreflightStatus): keyof typeof Ionicons.glyphMap {
    switch (status) {
        case 'ok':
            return 'checkmark-circle-outline';
        case 'warning':
            return 'warning-outline';
        case 'action_required':
            return 'alert-circle-outline';
    }
}

function statusColor(status: TeamPreflightStatus, theme: ReturnType<typeof useUnistyles>['theme']): string {
    switch (status) {
        case 'ok':
            return theme.colors.status.connected;
        case 'warning':
            return theme.colors.warning;
        case 'action_required':
            return theme.colors.textDestructive;
    }
}

function formatCheckTitle(check: TeamPreflightCheck): string {
    return check.key
        .split('_')
        .map((part) => part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1))
        .join(' ');
}

function formatCheckDetail(check: TeamPreflightCheck): string | undefined {
    const entries = Object.entries(check.detail ?? {})
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => `${key}: ${String(value)}`);
    return entries.length > 0 ? entries.join('\n') : undefined;
}

function summarySubtitle(preflight: TeamDeploymentPreflight): string {
    return [
        t('team.preflightServerUrl', { url: preflight.serverUrl }),
        t('team.preflightCheckedAt', { date: formatDate(preflight.checkedAt) }),
    ].join('\n');
}

export default function TeamPreflightScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [preflight, setPreflight] = React.useState<TeamDeploymentPreflight | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    const refresh = React.useCallback(async () => {
        if (!auth.credentials) {
            router.replace('/team/login');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const result = await getTeamPreflight(auth.credentials);
            setPreflight(result);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.preflightFailedToLoad'));
        } finally {
            setLoading(false);
        }
    }, [auth.credentials, router]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('team.preflightTitle') }} />
            <ItemList>
                <ItemGroup>
                    <View style={styles.form}>
                        <RoundButton title={t('common.retry')} size="normal" display="inverted" action={refresh} loading={loading} />
                    </View>
                </ItemGroup>

                <ItemGroup title={t('team.preflightOverall')}>
                    {loading && !preflight ? (
                        <View style={styles.form}>
                            <ActivityIndicator />
                        </View>
                    ) : error ? (
                        <Text style={styles.empty}>{error}</Text>
                    ) : preflight ? (
                        <Item
                            title={statusLabel(preflight.status)}
                            subtitle={summarySubtitle(preflight)}
                            subtitleLines={0}
                            showChevron={false}
                            icon={<Ionicons name={statusIcon(preflight.status)} size={29} color={statusColor(preflight.status, theme)} />}
                        />
                    ) : (
                        <Text style={styles.empty}>{t('team.preflightNoChecks')}</Text>
                    )}
                </ItemGroup>

                <ItemGroup title={t('team.preflightChecks')}>
                    {preflight && preflight.checks.length > 0 ? preflight.checks.map((check) => {
                        const detail = formatCheckDetail(check);
                        return (
                            <Item
                                key={check.key}
                                title={formatCheckTitle(check)}
                                subtitle={detail ? `${check.message}\n${detail}` : check.message}
                                subtitleLines={0}
                                detail={statusLabel(check.status)}
                                copy={detail ? `${check.message}\n${detail}` : check.message}
                                showChevron={false}
                                icon={<Ionicons name={statusIcon(check.status)} size={29} color={statusColor(check.status, theme)} />}
                            />
                        );
                    }) : !loading && !error ? (
                        <Text style={styles.empty}>{t('team.preflightNoChecks')}</Text>
                    ) : null}
                </ItemGroup>
            </ItemList>
        </>
    );
}
