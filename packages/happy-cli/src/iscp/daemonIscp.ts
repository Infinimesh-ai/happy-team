/**
 * Daemon-side ISCP service state: one DaemonEventLog per enrolled profile
 * plus a subscription fan-out for real-time wire events. Workstream 2 layers
 * the ISCP peer + wire responder on top of this; workstream 1 only ingests.
 */

import { EventEmitter } from 'node:events'
import { join } from 'node:path'

import { iscpProfileDir } from '@/iscp/enrollment'
import { DaemonEventLog, type EventLogAppendResult, type EventLogRecord } from '@/iscp/eventLog'

export interface IngestedSessionEvent {
  localId?: string
  body: unknown
}

export interface SessionEventNotification {
  profileId: string
  sessionId: string
  record: EventLogRecord
  epoch: string
  /** True when this append was a localId dedupe (no new record written). */
  deduped: boolean
}

export class DaemonIscpService {
  /** Injectable for tests; defaults to the enrolled profile directory. */
  constructor(private readonly profileDirFor: (profileId: string) => string = iscpProfileDir) {}

  private readonly logs = new Map<string, DaemonEventLog>()
  /** Emits 'session-event' with SessionEventNotification for live subscribers. */
  readonly events = new EventEmitter()
  /** sessionId → localhost RPC port of the running ISCP session process. */
  private readonly sessionRpcPorts = new Map<string, { profileId: string; port: number }>()

  registerSessionRpcPort(profileId: string, sessionId: string, port: number): void {
    this.sessionRpcPorts.set(sessionId, { profileId, port })
  }

  sessionRpcPort(sessionId: string): number | null {
    return this.sessionRpcPorts.get(sessionId)?.port ?? null
  }

  log(profileId: string): DaemonEventLog {
    if (profileId === '' || profileId.includes('/') || profileId.includes('\\') || profileId === '.' || profileId === '..') {
      throw new Error(`invalid ISCP profile id: ${JSON.stringify(profileId)}`)
    }
    let log = this.logs.get(profileId)
    if (!log) {
      log = new DaemonEventLog(join(this.profileDirFor(profileId), 'eventlog'))
      this.logs.set(profileId, log)
    }
    return log
  }

  /** Ingest a batch of session events (idempotent per localId). */
  ingest(profileId: string, sessionId: string, events: IngestedSessionEvent[]): EventLogAppendResult[] {
    const log = this.log(profileId)
    const results: EventLogAppendResult[] = []
    for (const event of events) {
      const result = log.append(sessionId, event.body, event.localId)
      results.push(result)
      this.events.emit('session-event', {
        profileId,
        sessionId,
        record: { seq: result.seq, ...(event.localId !== undefined ? { localId: event.localId } : {}), body: event.body, at: Date.now() },
        epoch: result.epoch,
        deduped: result.deduped,
      } satisfies SessionEventNotification)
    }
    return results
  }
}
