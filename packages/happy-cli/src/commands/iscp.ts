/**
 * `happy iscp` — ISCP device enrollment and profile inspection (dual-stack
 * Phase 2 slice; the ISCP transport itself lands in Phase 3).
 */

import chalk from 'chalk'

import { createNobleProvider, identityThumbprint } from '@slopus/iscp'

import { deviceConfirmationCode, enroll, iscpProfileDir, listProfiles, readProfileBundle } from '@/iscp/enrollment'

function printHelp(): void {
  console.log(`
${chalk.bold('happy iscp')} - ISCP device enrollment (dual-stack)

${chalk.bold('Usage:')}
  happy iscp enroll [ticket] [options]   Enroll this machine as an ISCP device
  happy iscp status [profile]            Show enrolled ISCP profiles
  happy iscp help                        Show this help

${chalk.bold('Arguments:')}
  ticket                Pairing ticket: base64url payload from a QR/deep link
                        (happy://iscp-enroll?ticket=...), a JSON string, or a
                        path to a ticket JSON file. Omit for the local-lab
                        bind-self dev flow.

${chalk.bold('Options:')}
  --relay-url <url>     Relay base URL           (default http://localhost:18080)
  --trust-url <url>     Trust root base URL      (default http://localhost:18081)
  --relay-id <id>       Relay id                 (default relay-local)
  --trust-root-id <id>  Trust root id            (default trust-local)
  --domain <id>         ISCP domain id           (default local)
  --device-id <id>      Device id                (default generated happy-cli-<rand>)
  --profile <id>        Profile id               (default <domain>-<relay-id>)

${chalk.bold('Notes:')}
  - The device identity key is generated locally and stored only in
    ~/.happy/iscp/<profile>/device.key (0600). It never leaves this machine.
  - During enrollment a 6-digit device confirmation code is printed; the
    operator authorizing the device should compare it out of band.
  - The defaults match the reference harness:
      docker compose -f environments/iscp/docker-compose.yaml up --build -d
`)
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  args.splice(index, 2)
  return value
}

async function handleEnroll(args: string[]): Promise<void> {
  const relayUrl = takeOption(args, '--relay-url') ?? 'http://localhost:18080'
  const trustUrl = takeOption(args, '--trust-url') ?? 'http://localhost:18081'
  const relayId = takeOption(args, '--relay-id') ?? 'relay-local'
  const trustRootId = takeOption(args, '--trust-root-id') ?? 'trust-local'
  const domainId = takeOption(args, '--domain') ?? 'local'
  const deviceId = takeOption(args, '--device-id')
  const profileId = takeOption(args, '--profile')
  const unknown = args.find((a) => a.startsWith('--'))
  if (unknown !== undefined) {
    throw new Error(`unknown option ${unknown} (see: happy iscp help)`)
  }
  const ticket = args[0]

  const { profileId: enrolledProfile } = await enroll({
    relayUrl,
    trustUrl,
    relayId,
    trustRootId,
    domainId,
    ticket,
    deviceId,
    profileId,
    log: (line) => console.log(line),
  })
  console.log('')
  console.log(chalk.green(`✓ ISCP profile "${enrolledProfile}" is ready`))
}

function handleStatus(args: string[]): void {
  const provider = createNobleProvider()
  const filter = args[0]
  const profiles = filter !== undefined ? [filter] : listProfiles()
  if (profiles.length === 0) {
    console.log('No ISCP profiles enrolled. Run: happy iscp enroll')
    return
  }
  for (const profileId of profiles) {
    const bundle = readProfileBundle(profileId)
    if (!bundle) {
      console.log(`${chalk.yellow('!')} ${profileId}: missing or corrupt bundle at ${iscpProfileDir(profileId)}`)
      continue
    }
    console.log(`${chalk.bold(profileId)}  (${iscpProfileDir(profileId)})`)
    console.log(`  domain/relay/trust: ${bundle.domain_id} / ${bundle.relay_id} / ${bundle.trust_root_id}`)
    console.log(`  device:             ${bundle.device_identity.device_id}`)
    console.log(`  thumbprint:         ${identityThumbprint(provider, bundle.device_identity)}`)
    console.log(`  confirmation code:  ${deviceConfirmationCode(provider, bundle.device_identity)}`)
    console.log(`  grant:              ${bundle.trust_grant.grant_id} (expires ${bundle.trust_grant.expires_at})`)
    console.log(`  enrolled at:        ${bundle.enrolled_at}`)
  }
}

export async function handleIscpCommand(args: string[]): Promise<void> {
  const subcommand = args[0]
  switch (subcommand) {
    case 'enroll':
      await handleEnroll(args.slice(1))
      return
    case 'status':
      handleStatus(args.slice(1))
      return
    case 'help':
    case '--help':
    case undefined:
      printHelp()
      return
    default:
      throw new Error(`unknown iscp subcommand "${subcommand}" (see: happy iscp help)`)
  }
}
