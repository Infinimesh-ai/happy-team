/**
 * happy-wire.v1 responder: maps HappyWireRequest envelopes arriving over the
 * ISCP transport onto daemon capabilities. The daemon event log is the only
 * history source (messages.pull), and mutations dedupe via idempotencyKey
 * (= localId, same contract as the legacy /v3 endpoint).
 *
 * Method catalog (transport-owned; unknown methods → 'unsupported'):
 *   sessions.list / sessions.spawn / sessions.stop
 *   messages.pull { sessionId, afterCursor?, limit? }
 *   messages.send { sessionId, body }        (idempotencyKey required)
 *   session.rpc   { sessionId, method, params }
 *   machine.rpc   { method, params }
 *   events.subscribe { }                     (live push flag; caller pulls backlog)
 *   wakeup.v1                                (Phase 4/5 hook point → unsupported)
 *
 * Deliberate Phase 3 scoping: ISCP sessions still create their legacy server
 * session (the machine keeps dual-stack credentials); history and RPC flow
 * through ISCP. Fully serverless sessions are a later phase.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import {
  encodeWireCursor,
  decodeWireCursor,
  type HappyWireRequest,
  type HappyWireResponse,
  type HappyWireError,
} from '@slopus/happy-wire'

import type { TrackedSession } from '@/daemon/types'
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers'
import { logger } from '@/ui/logger'
import type { DaemonIscpService } from '@/iscp/daemonIscp'
import { USER_MESSAGE_METHOD } from '@/iscp/sessionRpcServer'

const SessionsSpawnParams = z.object({
  directory: z.string().min(1),
  agent: z.enum(['claude', 'codex', 'gemini', 'openclaw', 'agy']).optional(),
  permissionMode: z.string().optional(),
  modelMode: z.string().optional(),
})

const SessionsStopParams = z.object({ sessionId: z.string().min(1) })

const MessagesPullParams = z.object({
  sessionId: z.string().min(1),
  afterCursor: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

const MessagesSendParams = z.object({
  sessionId: z.string().min(1),
  body: z.unknown(),
})

const SessionRpcParams = z.object({
  sessionId: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
})

const MachineRpcParams = z.object({
  method: z.string().min(1),
  params: z.unknown(),
})

function failure(id: string, code: HappyWireError['code'], message: string): HappyWireResponse {
  return { ok: false, id, error: { code, message } }
}

function success(id: string, result: unknown): HappyWireResponse {
  return { ok: true, id, result }
}

export interface WireResponderDeps {
  iscp: DaemonIscpService
  profileId: string
  getChildren: () => TrackedSession[]
  stopSession: (sessionId: string) => boolean
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export class WireResponder {
  constructor(private readonly deps: WireResponderDeps) {}

  async handle(request: HappyWireRequest): Promise<HappyWireResponse> {
    try {
      switch (request.method) {
        case 'sessions.list':
          return success(request.id, this.sessionsList())
        case 'sessions.spawn':
          return await this.sessionsSpawn(request)
        case 'sessions.stop': {
          const params = SessionsStopParams.parse(request.params)
          return success(request.id, { stopped: this.deps.stopSession(params.sessionId) })
        }
        case 'messages.pull':
          return this.messagesPull(request)
        case 'messages.send':
          return await this.messagesSend(request)
        case 'session.rpc':
          return await this.sessionRpc(request)
        case 'machine.rpc':
          return await this.machineRpc(request)
        case 'events.subscribe':
          // Subscription state is tracked by the peer runner (per device);
          // this response just acknowledges the switch to live push.
          return success(request.id, { subscribed: true })
        case 'wakeup.v1':
          // Phase 4/5 hook point: Cloud-triggered wakeups (data-only push).
          return failure(request.id, 'unsupported', 'wakeup.v1 is not available in this phase')
        default:
          return failure(request.id, 'unsupported', `unknown method ${request.method}`)
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        return failure(request.id, 'invalid', `invalid params for ${request.method}`)
      }
      logger.debug('[WIRE RESPONDER] request failed', { method: request.method, error })
      return failure(request.id, 'retryable', error instanceof Error ? error.message : 'internal error')
    }
  }

  private sessionsList(): unknown {
    const log = this.deps.iscp.log(this.deps.profileId)
    const running = new Map<string, TrackedSession>()
    for (const child of this.deps.getChildren()) {
      if (child.happySessionId !== undefined) running.set(child.happySessionId, child)
    }
    const known = new Set<string>([...running.keys(), ...log.listSessions()])
    const sessions = [...known].map((sessionId) => {
      const info = log.sessionInfo(sessionId)
      return {
        sessionId,
        active: running.has(sessionId),
        pid: running.get(sessionId)?.pid,
        lastSeq: info?.lastSeq ?? 0,
        lastCursor: info ? encodeWireCursor({ scope: sessionId, seq: info.lastSeq, epoch: info.epoch }) : undefined,
      }
    })
    return { sessions }
  }

  private async sessionsSpawn(request: HappyWireRequest): Promise<HappyWireResponse> {
    const params = SessionsSpawnParams.parse(request.params)
    const result = await this.deps.spawnSession({
      directory: params.directory,
      agent: params.agent,
      permissionMode: params.permissionMode,
      modelMode: params.modelMode,
      environmentVariables: { HAPPY_NETWORK_PROFILE: this.deps.profileId },
    })
    switch (result.type) {
      case 'success':
        if (!result.sessionId) {
          return failure(request.id, 'retryable', 'spawn returned no session id')
        }
        return success(request.id, { sessionId: result.sessionId })
      case 'requestToApproveDirectoryCreation':
        return failure(request.id, 'conflict', `directory requires approval: ${result.directory}`)
      case 'error':
        return failure(request.id, 'invalid', result.errorMessage)
    }
  }

  private messagesPull(request: HappyWireRequest): HappyWireResponse {
    const params = MessagesPullParams.parse(request.params)
    const log = this.deps.iscp.log(this.deps.profileId)
    const info = log.sessionInfo(params.sessionId)
    if (!info) {
      return success(request.id, { events: [], hasMore: false, lastCursor: null, reset: false })
    }
    // Cursor validation: wrong scope or stale epoch → full re-sync from 0,
    // flagged so the client knows to discard local state.
    let afterSeq = 0
    let reset = false
    if (params.afterCursor !== undefined) {
      const cursor = decodeWireCursor(params.afterCursor)
      if (cursor !== null && cursor.scope === params.sessionId && cursor.epoch === info.epoch) {
        afterSeq = cursor.seq
      } else {
        reset = true
      }
    }
    const page = log.read(params.sessionId, afterSeq, params.limit ?? 200)!
    return success(request.id, {
      events: page.events.map((event) => ({
        seq: event.seq,
        cursor: encodeWireCursor({ scope: params.sessionId, seq: event.seq, epoch: page.epoch }),
        ...(event.localId !== undefined ? { localId: event.localId } : {}),
        body: event.body,
        at: event.at,
      })),
      hasMore: page.hasMore,
      lastCursor: encodeWireCursor({ scope: params.sessionId, seq: page.lastSeq, epoch: page.epoch }),
      reset,
    })
  }

  private async messagesSend(request: HappyWireRequest): Promise<HappyWireResponse> {
    const params = MessagesSendParams.parse(request.params)
    if (request.idempotencyKey === undefined || request.idempotencyKey === '') {
      return failure(request.id, 'invalid', 'messages.send requires an idempotencyKey')
    }
    const result = this.deps.iscp.ingest(this.deps.profileId, params.sessionId, [
      { localId: request.idempotencyKey, body: params.body },
    ])[0]
    // Forward to the running session exactly once (dedupe suppresses redelivery).
    if (!result.deduped) {
      const delivered = await this.forwardToSession(params.sessionId, USER_MESSAGE_METHOD, params.body)
      if (delivered !== null) {
        logger.debug('[WIRE RESPONDER] user message forwarded', { sessionId: params.sessionId, seq: result.seq })
      }
    }
    return success(request.id, {
      seq: result.seq,
      deduped: result.deduped,
      cursor: encodeWireCursor({ scope: params.sessionId, seq: result.seq, epoch: result.epoch }),
    })
  }

  private async sessionRpc(request: HappyWireRequest): Promise<HappyWireResponse> {
    const params = SessionRpcParams.parse(request.params)
    const result = await this.forwardToSession(params.sessionId, params.method, params.params)
    if (result === null) {
      return failure(request.id, 'not_found', `session ${params.sessionId} is not reachable`)
    }
    if (!result.ok) {
      return failure(request.id, 'invalid', result.error)
    }
    return success(request.id, result.result)
  }

  private async machineRpc(request: HappyWireRequest): Promise<HappyWireResponse> {
    const params = MachineRpcParams.parse(request.params)
    switch (params.method) {
      case 'spawn-happy-session':
        return await this.sessionsSpawn({ ...request, params: params.params })
      case 'stop-session': {
        const stop = SessionsStopParams.parse(params.params)
        return success(request.id, { stopped: this.deps.stopSession(stop.sessionId) })
      }
      default:
        return failure(request.id, 'unsupported', `unknown machine method ${params.method}`)
    }
  }

  private async forwardToSession(
    sessionId: string,
    method: string,
    params: unknown,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string } | null> {
    const port = this.deps.iscp.sessionRpcPort(sessionId)
    if (port === null) return null
    const fetchImpl = this.deps.fetchImpl ?? fetch
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(30_000),
      })
      const body = (await response.json()) as { ok: boolean; result?: unknown; error?: string }
      if (body.ok) return { ok: true, result: body.result ?? null }
      return { ok: false, error: body.error ?? 'session rpc failed' }
    } catch (error) {
      logger.debug('[WIRE RESPONDER] session rpc unreachable', { sessionId, method, error })
      return null
    }
  }
}

export function newWireRequestId(): string {
  return randomUUID()
}
