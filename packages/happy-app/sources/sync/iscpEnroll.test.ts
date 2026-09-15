import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createDevice, createNobleProvider, signObject, signPairingTicket,
    PAIRING_TICKET_V3_TYPE, TRUST_GRANT_TYPE, toBase64Url, utf8Encode,
    type Device,
} from '@slopus/iscp';

const mocks = vi.hoisted(() => ({ register: vi.fn(), trust: {} as any, save: vi.fn() }));
vi.mock('./networkProfile', () => ({ saveIscpProfile: mocks.save }));
vi.mock('@slopus/iscp', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@slopus/iscp')>();
    return {
        ...actual,
        RelayHttpClient: class {
            fetchSignedDescriptor = async () => ({ descriptor: {} });
            registerWithSignedTicket = mocks.register;
        },
        TrustRootClient: class { fetchSignedDescriptor = async () => ({}); },
        verifyRelayDescriptor: vi.fn(),
        verifyTrustRootDescriptor: () => mocks.trust,
    };
});

import { enrollIscpDevice } from './iscpEnroll';

const provider = createNobleProvider();
const issuer = createDevice(provider, { domainId: 'domain', deviceId: 'trust' });
const opts = { relayUrl: 'https://relay.invalid', trustUrl: 'https://trust.invalid', relayId: 'relay', trustRootId: 'trust', domainId: 'domain', agentDeviceId: 'agent' };

function ticket(version: 2 | 3) {
    const fields = {
        ticket_id: 'ticket', domain_id: 'domain', relay_id: 'relay', trust_root_id: 'trust',
        max_uses: 1, issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    return version === 2 ? signPairingTicket(provider, issuer, fields) : signObject(provider, PAIRING_TICKET_V3_TYPE, {
        ...fields, type: PAIRING_TICKET_V3_TYPE, purpose: 'invite', consumer_role: 'member_device',
        grant_audience: 'controller', grant_permissions: ['text'],
    }, issuer.privateKey, issuer.identity.public_key.kid);
}

function encoded(value: unknown) { return toBase64Url(utf8Encode(JSON.stringify(value))); }

function registration(device: Device, audience = 'controller') {
    const grant = signObject(provider, TRUST_GRANT_TYPE, {
        type: TRUST_GRANT_TYPE, grant_id: 'grant', issuer: 'trust',
        subject_device_id: 'official-app', audience,
        confirmation_thumbprint: device.identity.public_key.kid,
        permissions: ['text'], relay_constraints: ['relay'], revocation_epoch: 0,
        not_before: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
    }, issuer.privateKey, issuer.identity.public_key.kid);
    return { data: { domain_id: 'domain', device_id: 'official-app' }, grant,
        access: { token: 'test-access' }, refresh: { token: 'test-refresh' } };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.trust = { keys: [{ kid: issuer.identity.public_key.kid, public: issuer.identity.public_key.public, state: 'active' }] };
    mocks.register.mockImplementation(async (device: Device) => registration(device));
});

describe('app signed ticket enrollment', () => {
    it.each([2, 3] as const)('verifies and consumes a v%s ticket without persisting before confirmation', async (version) => {
        const pending = await enrollIscpDevice({ ...opts, ticket: encoded(ticket(version)) });
        expect(pending.data.deviceIdentity.device_id).toBe('official-app');
        expect(pending.confirmationCode).toMatch(/^\d{6}$/);
        expect(mocks.register).toHaveBeenCalledOnce();
        expect(mocks.save).not.toHaveBeenCalled();
    });

    it('rejects an inconsistent wrapper audience before consuming the ticket', async () => {
        await expect(enrollIscpDevice({ ...opts, ticket: encoded({ ticket_v3: ticket(3), expected_audience_phone_id: 'other' }) }))
            .rejects.toThrow('audience');
        expect(mocks.register).not.toHaveBeenCalled();
    });

    it('checks the returned grant against the signed v3 audience even without a wrapper hint', async () => {
        mocks.register.mockImplementation(async (device: Device) => registration(device, 'wrong-controller'));
        await expect(enrollIscpDevice({ ...opts, ticket: encoded(ticket(3)) })).rejects.toThrow();
        expect(mocks.register).toHaveBeenCalledOnce();
        expect(mocks.save).not.toHaveBeenCalled();
    });
});
