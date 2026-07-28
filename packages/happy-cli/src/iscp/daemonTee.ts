/**
 * ISCP-mode session event tee: routes a session's outbound history events to
 * the daemon's event log instead of happy-server (dual-stack frozen decision
 * #3 — the daemon is the only history source in ISCP mode).
 *
 * Active only when the daemon spawned this session with HAPPY_NETWORK_PROFILE
 * set. Legacy mode never constructs this class, keeping the legacy path
 * byte-identical.
 *
 * Buffering mirrors the legacy outbox: events accumulate in memory and an
 * InvalidateSync flushes them in FIFO batches; if the daemon is briefly down
 * (restart, upgrade) events stay queued and are retried with backoff, so the
 * hot path never blocks on the extra localhost hop.
 */

import { randomUUID } from 'node:crypto'

import { daemonPost } from '@/daemon/controlClient'
import { logger } from '@/ui/logger'
import { InvalidateSync } from '@/utils/sync'
import { delay } from '@/utils/time'

/** Profile id when this process runs in ISCP mode, else null. */
export function iscpNetworkProfile(): string | null {
  const value = process.env.HAPPY_NETWORK_PROFILE
  return value !== undefined && value !== '' ? value : null
}

interface PendingEvent {
  localId: string
  body: unknown
}

const MAX_BATCH_SIZE = 50
const RETRY_DELAY_MS = 1000

export class DaemonSessionEventTee {
  private readonly pending: PendingEvent[] = []
  private readonly sync: InvalidateSync

  constructor(
    private readonly profileId: string,
    private readonly sessionId: string,
  ) {
    this.sync = new InvalidateSync(() => this.flushPending())
  }

  /** Queue one history event. localId is the idempotency key (defaults to a fresh UUID). */
  enqueue(body: unknown, localId?: string): void {
    this.pending.push({ localId: localId ?? randomUUID(), body })
    this.sync.invalidate()
  }

  get pendingCount(): number {
    return this.pending.length
  }

  /** Wait until everything queued so far has reached the daemon. */
  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      await this.sync.invalidateAndAwait()
      if (this.pending.length > 0) {
        await delay(RETRY_DELAY_MS)
      }
    }
  }

  private async flushPending(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.slice(0, MAX_BATCH_SIZE)
      const result = await daemonPost('/iscp/session-event', {
        profileId: this.profileId,
        sessionId: this.sessionId,
        events: batch.map((event) => ({ localId: event.localId, body: event.body })),
      })
      if (result?.error) {
        // Daemon unreachable (restart/upgrade): keep the batch queued and let
        // InvalidateSync's backoff retry. The hot path never blocks on this.
        logger.debug('[ISCP TEE] daemon ingestion failed, keeping events queued', { error: result.error, queued: this.pending.length })
        throw new Error(`daemon ingestion failed: ${result.error}`)
      }
      this.pending.splice(0, batch.length)
    }
  }
}
