/**
 * Network profile registry (dual-stack Phase 3).
 *
 * A network profile is the unit of identity, storage namespacing, and logout
 * (HappyNetworkProfile in @slopus/happy-wire). Rules:
 *
 * - 'legacy-default' is synthesized from the existing auth_credentials at
 *   read time and NEVER persisted here — existing users get a profile with
 *   zero migration, and wiping this registry can never break legacy auth.
 * - ISCP profiles are persisted in a dedicated MMKV instance
 *   ('happy-profiles'); their secrets live under the SecureStore key
 *   `iscp_device_<profileId>` and their transport cache (cursors) in the
 *   MMKV instance `cache-<profileId>`.
 * - wipeProfile(id) erases exactly that profile's namespace: legacy logout
 *   never touches ISCP keys, ISCP wipe never touches auth_credentials.
 */

import { MMKV } from 'react-native-mmkv';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { HappyNetworkProfile } from '@slopus/happy-wire';
import type { DeviceIdentity, SignedDescriptor, TrustGrant } from '@slopus/iscp';

import { TokenStorage } from '@/auth/tokenStorage';

export const LEGACY_PROFILE_ID = 'legacy-default';

const profilesStorage = new MMKV({ id: 'happy-profiles' });

const ISCP_PROFILES_KEY = 'iscp-profiles';
const ACTIVE_PROFILE_KEY = 'active-profile';

/** Everything an ISCP profile needs to come online (stored in SecureStore). */
export interface IscpProfileData {
    version: 1;
    profileId: string;
    domainId: string;
    relayId: string;
    trustRootId: string;
    relayBaseUrl: string;
    trustBaseUrl: string;
    /** The daemon's ISCP device id this profile talks to. */
    agentDeviceId: string;
    deviceSeedB64: string;
    deviceIdentity: DeviceIdentity;
    accessToken: string;
    refreshToken: string;
    trustGrant: TrustGrant;
    relayDescriptor: SignedDescriptor;
    enrolledAt: string;
}

interface PersistedIscpProfile {
    id: string;
    deviceId: string;
    domainId: string;
    relayHint?: string;
}

function readPersistedIscpProfiles(): PersistedIscpProfile[] {
    const raw = profilesStorage.getString(ISCP_PROFILES_KEY);
    if (!raw) return [];
    try {
        return JSON.parse(raw) as PersistedIscpProfile[];
    } catch {
        return [];
    }
}

function writePersistedIscpProfiles(profiles: PersistedIscpProfile[]): void {
    profilesStorage.set(ISCP_PROFILES_KEY, JSON.stringify(profiles));
}

function iscpSecretKey(profileId: string): string {
    return `iscp_device_${profileId}`;
}

async function getSecret(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
        return localStorage.getItem(key);
    }
    return await SecureStore.getItemAsync(key);
}

async function setSecret(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
        localStorage.setItem(key, value);
        return;
    }
    await SecureStore.setItemAsync(key, value);
}

async function deleteSecret(key: string): Promise<void> {
    if (Platform.OS === 'web') {
        localStorage.removeItem(key);
        return;
    }
    await SecureStore.deleteItemAsync(key);
}

/** All profiles: synthesized legacy-default (when logged in) + persisted ISCP entries. */
export async function getNetworkProfiles(): Promise<HappyNetworkProfile[]> {
    const profiles: HappyNetworkProfile[] = [];
    const legacyCredentials = await TokenStorage.getCredentials();
    if (legacyCredentials) {
        profiles.push({
            id: LEGACY_PROFILE_ID,
            mode: 'legacy',
            accountId: 'legacy',
            serverUrl: '',
        });
    }
    for (const entry of readPersistedIscpProfiles()) {
        profiles.push({
            id: entry.id,
            mode: 'iscp',
            deviceId: entry.deviceId,
            domainId: entry.domainId,
            credentialRef: iscpSecretKey(entry.id),
            relayHint: entry.relayHint,
        });
    }
    return profiles;
}

export function getActiveProfileId(): string {
    return profilesStorage.getString(ACTIVE_PROFILE_KEY) ?? LEGACY_PROFILE_ID;
}

export function setActiveProfileId(profileId: string): void {
    profilesStorage.set(ACTIVE_PROFILE_KEY, profileId);
}

/** Persist a freshly enrolled ISCP profile (registry entry + SecureStore secret). */
export async function saveIscpProfile(data: IscpProfileData): Promise<void> {
    await setSecret(iscpSecretKey(data.profileId), JSON.stringify(data));
    const entries = readPersistedIscpProfiles().filter((entry) => entry.id !== data.profileId);
    entries.push({
        id: data.profileId,
        deviceId: data.deviceIdentity.device_id,
        domainId: data.domainId,
        relayHint: data.relayBaseUrl,
    });
    writePersistedIscpProfiles(entries);
}

export async function readIscpProfileData(profileId: string): Promise<IscpProfileData | null> {
    const raw = await getSecret(iscpSecretKey(profileId));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as IscpProfileData;
    } catch {
        return null;
    }
}

/** Persist rotated relay credentials for a profile. */
export async function updateIscpProfileCredentials(profileId: string, credentials: { accessToken: string; refreshToken: string }): Promise<void> {
    const data = await readIscpProfileData(profileId);
    if (!data) return;
    await setSecret(iscpSecretKey(profileId), JSON.stringify({ ...data, accessToken: credentials.accessToken, refreshToken: credentials.refreshToken }));
}

/** Transport cache (cursors etc.) for one ISCP profile — its own MMKV namespace. */
export function iscpProfileCache(profileId: string): MMKV {
    return new MMKV({ id: `cache-${profileId}` });
}

/**
 * Wipe exactly one profile's namespace.
 *
 * - legacy-default: this registry holds nothing for it; the caller runs the
 *   existing legacy logout (TokenStorage + sync storage), which this function
 *   deliberately does not duplicate or touch.
 * - ISCP profile: SecureStore secret + cache MMKV + registry entry.
 */
export async function wipeProfile(profileId: string): Promise<void> {
    if (profileId === LEGACY_PROFILE_ID) {
        if (getActiveProfileId() === LEGACY_PROFILE_ID) {
            profilesStorage.delete(ACTIVE_PROFILE_KEY);
        }
        return;
    }
    await deleteSecret(iscpSecretKey(profileId));
    iscpProfileCache(profileId).clearAll();
    writePersistedIscpProfiles(readPersistedIscpProfiles().filter((entry) => entry.id !== profileId));
    if (getActiveProfileId() === profileId) {
        profilesStorage.delete(ACTIVE_PROFILE_KEY);
    }
}
