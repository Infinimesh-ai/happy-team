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
import { listTeamMachines, TeamMachine } from '@/team/api';

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

function formatDate(value: string | number): string {
    return new Date(value).toLocaleString();
}

function machineSubtitle(machine: TeamMachine): string {
    return [
        machine.ownerEmail ?? t('team.unknownOwner'),
        machine.active ? t('status.online') : t('status.offline'),
        t('team.lastSeen', { date: formatDate(machine.activeAt) }),
    ].join(' / ');
}

export default function TeamMachinesScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [machines, setMachines] = React.useState<TeamMachine[]>([]);
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
            const result = await listTeamMachines(auth.credentials);
            setMachines(result.machines);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.failedToLoadMachines'));
        } finally {
            setLoading(false);
        }
    }, [auth.credentials, router]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('team.machinesTitle') }} />
            <ItemList>
                <ItemGroup>
                    <View style={styles.form}>
                        <RoundButton title={t('common.retry')} size="normal" display="inverted" action={refresh} loading={loading} />
                    </View>
                </ItemGroup>
                <ItemGroup title={t('team.machines')}>
                    {loading ? (
                        <View style={styles.form}>
                            <ActivityIndicator />
                        </View>
                    ) : error ? (
                        <Text style={styles.empty}>{error}</Text>
                    ) : machines.length === 0 ? (
                        <Text style={styles.empty}>{t('team.noMachinesYet')}</Text>
                    ) : machines.map((machine) => (
                        <Item
                            key={machine.id}
                            title={machine.id}
                            subtitle={machineSubtitle(machine)}
                            subtitleLines={2}
                            detail={machine.ownerEmail ?? undefined}
                            copy={machine.id}
                            showChevron={false}
                            icon={(
                                <Ionicons
                                    name="desktop-outline"
                                    size={29}
                                    color={machine.active ? theme.colors.status.connected : theme.colors.status.disconnected}
                                />
                            )}
                        />
                    ))}
                </ItemGroup>
            </ItemList>
        </>
    );
}
