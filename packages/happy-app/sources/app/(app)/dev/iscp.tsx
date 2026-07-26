import React from 'react';
import { Platform, Text, TextInput, View } from 'react-native';
import { Stack } from 'expo-router';

import type { HappyNetworkProfile } from '@slopus/happy-wire';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import { confirmIscpEnrollment, enrollIscpDevice, type IscpEnrollmentPending } from '@/sync/iscpEnroll';
import {
    getActiveProfileId,
    getNetworkProfiles,
    setActiveProfileId,
    wipeProfile,
} from '@/sync/networkProfile';

/**
 * Dev page for ISCP enrollment (dual-stack Phase 3). Defaults match the
 * reference harness (environments/iscp/docker-compose.yaml); the agent
 * device id comes from `happy iscp status` on the machine. The polished
 * QR/deep-link flow arrives with the Cloud integration phase.
 */
export default React.memo(function IscpDevPage() {
    const [relayUrl, setRelayUrl] = React.useState('http://localhost:18080');
    const [trustUrl, setTrustUrl] = React.useState('http://localhost:18081');
    const [agentDeviceId, setAgentDeviceId] = React.useState('');
    const [ticket, setTicket] = React.useState('');
    const [pending, setPending] = React.useState<IscpEnrollmentPending | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [profiles, setProfiles] = React.useState<HappyNetworkProfile[]>([]);
    const [activeId, setActiveId] = React.useState(getActiveProfileId());

    const refresh = React.useCallback(() => {
        void getNetworkProfiles().then(setProfiles);
        setActiveId(getActiveProfileId());
    }, []);
    React.useEffect(refresh, [refresh]);

    const enroll = React.useCallback(async () => {
        if (busy) return;
        if (agentDeviceId.trim() === '') {
            Modal.alert('ISCP', 'Agent device id is required (see `happy iscp status` on the machine).', [{ text: 'OK' }]);
            return;
        }
        setBusy(true);
        try {
            const result = await enrollIscpDevice({
                relayUrl: relayUrl.trim(),
                trustUrl: trustUrl.trim(),
                relayId: 'relay-local',
                trustRootId: 'trust-local',
                domainId: 'local',
                agentDeviceId: agentDeviceId.trim(),
                ticket: ticket.trim() === '' ? undefined : ticket.trim(),
            });
            setPending(result);
        } catch (error) {
            Modal.alert('Enrollment failed', error instanceof Error ? error.message : 'Unknown error', [{ text: 'OK' }]);
        } finally {
            setBusy(false);
        }
    }, [busy, relayUrl, trustUrl, agentDeviceId, ticket]);

    const confirm = React.useCallback(async () => {
        if (!pending) return;
        const profileId = await confirmIscpEnrollment(pending);
        setPending(null);
        refresh();
        Modal.alert('ISCP', `Profile "${profileId}" enrolled.`, [{ text: 'OK' }]);
    }, [pending, refresh]);

    const wipe = React.useCallback((profileId: string) => {
        Modal.alert('Wipe profile?', `This erases the "${profileId}" namespace only (device key, credentials, cursors). Other profiles are untouched.`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Wipe',
                style: 'destructive',
                onPress: () => {
                    void wipeProfile(profileId).then(refresh);
                },
            },
        ]);
    }, [refresh]);

    return (
        <>
            <Stack.Screen options={{ title: 'ISCP (dev)', headerLargeTitle: false }} />
            <ItemList>
                <ItemGroup title="Enroll this app" footer="Defaults target the local reference harness. Paste a pairing ticket for the ticket flow; leave empty for local-lab bind-self.">
                    <View style={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}>
                        <TextInput
                            value={relayUrl}
                            onChangeText={setRelayUrl}
                            placeholder="Relay URL"
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={inputStyle}
                        />
                        <TextInput
                            value={trustUrl}
                            onChangeText={setTrustUrl}
                            placeholder="Trust root URL"
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={inputStyle}
                        />
                        <TextInput
                            value={agentDeviceId}
                            onChangeText={setAgentDeviceId}
                            placeholder="Agent device id (happy iscp status)"
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={inputStyle}
                        />
                        <TextInput
                            value={ticket}
                            onChangeText={setTicket}
                            placeholder="Pairing ticket (optional)"
                            autoCapitalize="none"
                            autoCorrect={false}
                            style={inputStyle}
                        />
                    </View>
                    <Item
                        title={busy ? 'Enrolling…' : 'Enroll'}
                        onPress={enroll}
                    />
                </ItemGroup>
                {pending && (
                    <ItemGroup title="Confirm device" footer="Compare this code with the operator (out of band) before confirming. Nothing is stored until you confirm.">
                        <View style={{ paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center' }}>
                            <Text style={{ fontSize: 34, letterSpacing: 6, ...Typography.mono() }}>
                                {pending.confirmationCode}
                            </Text>
                            <Text style={{ opacity: 0.6, marginTop: 4 }} numberOfLines={1}>
                                {pending.data.deviceIdentity.device_id}
                            </Text>
                        </View>
                        <Item title="Codes match — save profile" onPress={() => void confirm()} />
                        <Item title="Discard" onPress={() => setPending(null)} destructive />
                    </ItemGroup>
                )}
                <ItemGroup title="Network profiles" footer="Switching the active profile takes effect on next app start (Phase 3).">
                    {profiles.length === 0 && <Item title="No profiles" />}
                    {profiles.map((profile) => (
                        <Item
                            key={profile.id}
                            title={profile.id}
                            subtitle={profile.mode === 'iscp' ? `iscp · ${profile.deviceId}` : 'legacy'}
                            detail={profile.id === activeId ? 'active' : undefined}
                            onPress={() => {
                                setActiveProfileId(profile.id);
                                refresh();
                            }}
                            onLongPress={profile.mode === 'iscp' ? () => wipe(profile.id) : undefined}
                        />
                    ))}
                </ItemGroup>
            </ItemList>
        </>
    );
});

const inputStyle = {
    borderWidth: 1,
    borderColor: '#8884',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'web' ? 8 : 6,
    fontSize: 14,
} as const;
