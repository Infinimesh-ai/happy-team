/**
 * ISCP enrollment for happy-cli (Phase 2 slice of the dual-stack plan).
 *
 * Enrolls this machine as an ISCP device against a relay + trust root and
 * persists the resulting profile under ~/.happy/iscp/<profileId>/:
 *
 *   device.key    0600  Ed25519 identity seed (never leaves this machine)
 *   bundle.json   0600  descriptors, pins, credentials, trust grant
 *
 * Layout is namespaced per profile so ISCP state never touches legacy
 * ~/.happy files, and legacy logout never touches ISCP state
 * (docs/network-dual-stack/inventory.md isolation contract).
 *
 * Against the reference services (local-lab) the CLI can play the operator
 * and self-authorize; against a gated trust root it polls for authorization
 * and expects the operator to compare the printed device confirmation code
 * out of band before approving.
 */

import { chmodSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  createDevice,
  createNobleProvider,
  decodeTicketFromTransport,
  descriptorPin,
  deviceFromStored,
  Ed25519PrivateKey,
  fromBase64Url,
  identityThumbprint,
  IscpError,
  RelayHttpClient,
  toBase64Url,
  TrustRootClient,
  utf8Encode,
  verifyRelayDescriptor,
  verifyTrustRootDescriptor,
  type CryptoProvider,
  type Device,
  type DeviceIdentity,
  type PairingTicket,
  type RelayCredentialPair,
  type SignedDescriptor,
  type TrustGrant,
} from '@slopus/iscp'

import { configuration } from '@/configuration'

/** Everything a Phase 3 transport needs to come online as this device. */
export interface IscpProfileBundle {
  version: 1
  profile_id: string
  domain_id: string
  relay_id: string
  trust_root_id: string
  relay_descriptor: SignedDescriptor
  relay_pin: string
  trust_root_descriptor: SignedDescriptor
  trust_root_pin: string
  device_identity: DeviceIdentity
  access_credential: { token: string; expires_at: string }
  refresh_credential: { token: string; expires_at: string }
  trust_grant: TrustGrant
  enrolled_at: string
}

export interface EnrollOptions {
  relayUrl: string
  trustUrl: string
  relayId: string
  trustRootId: string
  domainId: string
  /** base64url ticket payload (QR/deep-link), raw ticket JSON, or a file path. */
  ticket?: string
  deviceId?: string
  profileId?: string
  /** Print progress lines (device confirmation code etc.). Never prints secrets. */
  log: (line: string) => void
}

export function iscpProfileDir(profileId: string): string {
  return join(configuration.happyHomeDir, 'iscp', profileId)
}

export function readProfileBundle(profileId: string): IscpProfileBundle | null {
  const file = join(iscpProfileDir(profileId), 'bundle.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as IscpProfileBundle
}

export function readProfileDevice(provider: CryptoProvider, profileId: string): Device | null {
  const bundle = readProfileBundle(profileId)
  const keyFile = join(iscpProfileDir(profileId), 'device.key')
  if (!bundle || !existsSync(keyFile)) return null
  const stored = JSON.parse(readFileSync(keyFile, 'utf8')) as { seed: string }
  return deviceFromStored(provider, bundle.device_identity, new Ed25519PrivateKey(fromBase64Url(stored.seed)))
}

export function listProfiles(): string[] {
  const root = join(configuration.happyHomeDir, 'iscp')
  if (!existsSync(root)) return []
  return readdirSync(root).filter((entry: string) => {
    try {
      return statSync(join(root, entry)).isDirectory() && existsSync(join(root, entry, 'bundle.json'))
    } catch {
      return false
    }
  })
}

function parseTicket(input: string): PairingTicket {
  if (existsSync(input)) {
    return JSON.parse(readFileSync(input, 'utf8')) as PairingTicket
  }
  if (input.trimStart().startsWith('{')) {
    return JSON.parse(input) as PairingTicket
  }
  return decodeTicketFromTransport(input)
}

/**
 * Six-digit device confirmation code derived from the identity thumbprint.
 * The operator authorizing this device compares it out of band (same shape
 * as the Local Secure Channel OOB code, but bound to the long-term identity
 * instead of an ephemeral channel).
 */
export function deviceConfirmationCode(provider: CryptoProvider, identity: DeviceIdentity): string {
  const digest = provider.sha256(utf8Encode(`iscp/happy/device-confirmation\0${identity.public_key.kid}`))
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
  return (view.getUint32(0) % 1_000_000).toString().padStart(6, '0')
}

function persistProfile(profileId: string, device: Device, bundle: IscpProfileBundle): string {
  const dir = iscpProfileDir(profileId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const keyFile = join(dir, 'device.key')
  writeFileSync(keyFile, JSON.stringify({ warning: 'ISCP device identity seed; never share', seed: toBase64Url(device.privateKey.bytes) }, null, 2), { mode: 0o600 })
  chmodSync(keyFile, 0o600)
  const bundleFile = join(dir, 'bundle.json')
  writeFileSync(bundleFile, JSON.stringify(bundle, null, 2), { mode: 0o600 })
  chmodSync(bundleFile, 0o600)
  return dir
}

/** Persist rotated relay credentials back into the profile bundle (0600). */
export function updateProfileCredentials(profileId: string, credentials: { accessToken: string; refreshToken: string }): void {
  const bundle = readProfileBundle(profileId)
  if (!bundle) return
  bundle.access_credential = { ...bundle.access_credential, token: credentials.accessToken }
  bundle.refresh_credential = { ...bundle.refresh_credential, token: credentials.refreshToken }
  const file = join(iscpProfileDir(profileId), 'bundle.json')
  writeFileSync(file, JSON.stringify(bundle, null, 2), { mode: 0o600 })
  chmodSync(file, 0o600)
}

export async function enroll(opts: EnrollOptions): Promise<{ profileId: string; dir: string; bundle: IscpProfileBundle }> {
  const provider = createNobleProvider()
  const { log } = opts

  // 1. Discover and verify both services; record pins.
  const relayHttp = new RelayHttpClient({ baseUrl: opts.relayUrl, relayId: opts.relayId, provider })
  const trustRoot = new TrustRootClient({ baseUrl: opts.trustUrl, trustRootId: opts.trustRootId, provider })
  const { descriptor: signedRelay } = await relayHttp.fetchSignedDescriptor()
  const relayDescriptor = verifyRelayDescriptor(provider, signedRelay)
  const signedTrust = await trustRoot.fetchSignedDescriptor()
  const trustDescriptor = verifyTrustRootDescriptor(provider, signedTrust)
  log(`Relay:      ${relayDescriptor.relay_id} (${relayDescriptor.base_url})`)
  log(`Trust root: ${trustDescriptor.trust_root_id} (${trustDescriptor.base_url})`)

  // 2. Generate the device identity locally. The seed is written only to
  //    device.key (0600) at the end; it never travels.
  const deviceId = opts.deviceId ?? `happy-cli-${toBase64Url(provider.randomBytes(9))}`
  const device = createDevice(provider, { domainId: opts.domainId, deviceId })
  const thumbprint = identityThumbprint(provider, device.identity)
  log(`Device id:  ${deviceId}`)
  log(`Thumbprint: ${thumbprint}`)
  log('')
  log(`  Device confirmation code: ${deviceConfirmationCode(provider, device.identity)}`)
  log('  Compare this code out of band before the operator authorizes the device.')
  log('')

  // 3. Relay access: pairing ticket when provided, bind-self otherwise (local-lab dev flow).
  let credentials: RelayCredentialPair
  if (opts.ticket !== undefined) {
    const ticket = parseTicket(opts.ticket)
    if (ticket.domain_id !== opts.domainId || ticket.relay_id !== opts.relayId) {
      throw new Error(`pairing ticket is for domain ${ticket.domain_id} / relay ${ticket.relay_id}, not ${opts.domainId} / ${opts.relayId}`)
    }
    credentials = await relayHttp.registerWithTicket(device, { ticketId: ticket.ticket_id, maxUses: ticket.max_uses })
    log(`Relay access granted via pairing ticket ${ticket.ticket_id}`)
  } else {
    credentials = await relayHttp.bindSelf(device)
    log('Relay access granted via bind-self (no ticket; local-lab dev flow)')
  }

  // 4. Trust: submit identity, then obtain a grant. Local-lab trust roots
  //    leave the operator endpoint open, so try self-authorization first and
  //    fall back to polling for an out-of-band operator approval.
  await trustRoot.submitDevice(device)
  log('Device submitted to trust root')
  let grant: TrustGrant
  try {
    const authorized = await trustRoot.authorizeDevice({
      deviceId,
      audience: opts.domainId,
      permissions: ['text'],
      relayId: opts.relayId,
      ttlSeconds: 3600,
    })
    grant = authorized.grant
    log('Device authorized (local-lab self-authorization)')
  } catch (error) {
    if (!(error instanceof IscpError && error.code === 'ISCPACCESS001')) throw error
    log('Trust root requires an operator. Waiting for authorization...')
    await trustRoot.waitForAuthorization(deviceId, { intervalMs: 2000, timeoutMs: 10 * 60 * 1000 })
    // Reference trust roots expose no device-facing grant fetch; the
    // operator must deliver the grant (Provisioning Bundle path, Phase 3+).
    throw new Error('device authorized, but this trust root delivers grants only via a provisioning bundle; re-run with a bundle once issued')
  }

  // 5. Persist the profile bundle.
  const profileId = opts.profileId ?? `${opts.domainId}-${opts.relayId}`
  const bundle: IscpProfileBundle = {
    version: 1,
    profile_id: profileId,
    domain_id: opts.domainId,
    relay_id: opts.relayId,
    trust_root_id: opts.trustRootId,
    relay_descriptor: signedRelay,
    relay_pin: descriptorPin(provider, signedRelay),
    trust_root_descriptor: signedTrust,
    trust_root_pin: descriptorPin(provider, signedTrust),
    device_identity: device.identity,
    access_credential: { token: credentials.access.token as string, expires_at: credentials.access.expires_at },
    refresh_credential: { token: credentials.refresh.token as string, expires_at: credentials.refresh.expires_at },
    trust_grant: grant,
    enrolled_at: new Date().toISOString(),
  }
  const dir = persistProfile(profileId, device, bundle)
  log('')
  log(`Enrolled. Profile stored at ${dir}`)
  log(`Grant ${grant.grant_id} (permissions: ${grant.permissions.join(', ')}) expires ${grant.expires_at}`)
  return { profileId, dir, bundle }
}
