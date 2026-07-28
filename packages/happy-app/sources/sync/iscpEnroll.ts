/**
 * App-side ISCP enrollment (dual-stack Phase 3).
 *
 * Two-step flow so the operator can compare the out-of-band device
 * confirmation code before anything is persisted:
 *   1. enrollIscpDevice(): generate identity locally, obtain relay access
 *      (pairing ticket or local-lab bind-self), submit to trust root and
 *      self-authorize (local-lab; gated trust roots deliver grants via a
 *      provisioning bundle in a later phase) — returns pending data + code;
 *   2. confirmIscpEnrollment(): persist the profile after the human confirms.
 *
 * The device private key is generated here and stored only in SecureStore
 * under this profile's namespace; it never leaves the device.
 */

import {
    RelayHttpClient,
    TrustRootClient,
    createDevice,
    createNobleProvider,
    decodeTicketFromTransport,
    identityThumbprint,
    toBase64Url,
    utf8Encode,
    verifyRelayDescriptor,
    verifyTrustRootDescriptor,
    type CryptoProvider,
    type DeviceIdentity,
} from '@slopus/iscp';

import { saveIscpProfile, type IscpProfileData } from './networkProfile';

export interface IscpEnrollOptions {
    relayUrl: string;
    trustUrl: string;
    relayId: string;
    trustRootId: string;
    domainId: string;
    /** The daemon's ISCP device id (shown by `happy iscp status` on the machine). */
    agentDeviceId: string;
    /** base64url pairing ticket payload from a QR/deep link; omit for local-lab bind-self. */
    ticket?: string;
    profileId?: string;
}

export interface IscpEnrollmentPending {
    data: IscpProfileData;
    confirmationCode: string;
}

/** Same derivation as happy-cli: 6 digits bound to the long-term identity kid. */
export function deviceConfirmationCode(provider: CryptoProvider, identity: DeviceIdentity): string {
    const digest = provider.sha256(utf8Encode(`iscp/happy/device-confirmation\0${identity.public_key.kid}`));
    const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
    return (view.getUint32(0) % 1_000_000).toString().padStart(6, '0');
}

export async function enrollIscpDevice(opts: IscpEnrollOptions): Promise<IscpEnrollmentPending> {
    const provider = createNobleProvider();

    const relayHttp = new RelayHttpClient({ baseUrl: opts.relayUrl, relayId: opts.relayId, provider });
    const trustRoot = new TrustRootClient({ baseUrl: opts.trustUrl, trustRootId: opts.trustRootId, provider });
    const { descriptor: signedRelay } = await relayHttp.fetchSignedDescriptor();
    verifyRelayDescriptor(provider, signedRelay);
    const signedTrust = await trustRoot.fetchSignedDescriptor();
    verifyTrustRootDescriptor(provider, signedTrust);

    const deviceId = `happy-app-${toBase64Url(provider.randomBytes(9))}`;
    const device = createDevice(provider, { domainId: opts.domainId, deviceId });

    let credentials;
    if (opts.ticket !== undefined && opts.ticket !== '') {
        const ticket = decodeTicketFromTransport(opts.ticket);
        credentials = await relayHttp.registerWithTicket(device, { ticketId: ticket.ticket_id, maxUses: ticket.max_uses });
    } else {
        credentials = await relayHttp.bindSelf(device);
    }

    await trustRoot.submitDevice(device);
    // local-lab trust roots leave the operator endpoint open; gated ones
    // reject this and require the provisioning-bundle flow (Phase 4).
    const { grant } = await trustRoot.authorizeDevice({
        deviceId,
        audience: opts.domainId,
        permissions: ['text'],
        relayId: opts.relayId,
        ttlSeconds: 3600,
    });

    const profileId = opts.profileId !== undefined && opts.profileId !== ''
        ? opts.profileId
        : `iscp-${opts.domainId}-${opts.relayId}`;
    const data: IscpProfileData = {
        version: 1,
        profileId,
        domainId: opts.domainId,
        relayId: opts.relayId,
        trustRootId: opts.trustRootId,
        relayBaseUrl: opts.relayUrl,
        trustBaseUrl: opts.trustUrl,
        agentDeviceId: opts.agentDeviceId,
        deviceSeedB64: toBase64Url(device.privateKey.bytes),
        deviceIdentity: device.identity,
        accessToken: credentials.access.token as string,
        refreshToken: credentials.refresh.token as string,
        trustGrant: grant,
        relayDescriptor: signedRelay,
        enrolledAt: new Date().toISOString(),
    };
    return { data, confirmationCode: deviceConfirmationCode(provider, device.identity) };
}

/** Persist the profile after the operator confirmed the OOB code (bundle_applied). */
export async function confirmIscpEnrollment(pending: IscpEnrollmentPending): Promise<string> {
    await saveIscpProfile(pending.data);
    return pending.data.profileId;
}

export function identityThumbprintOf(pending: IscpEnrollmentPending): string {
    return identityThumbprint(createNobleProvider(), pending.data.deviceIdentity);
}
