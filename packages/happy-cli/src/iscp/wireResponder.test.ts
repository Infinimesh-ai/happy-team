import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decodeWireCursor } from '@slopus/happy-wire'

import { DaemonIscpService } from './daemonIscp'
import { WireResponder } from './wireResponder'


describe('WireResponder', () => {
  let root: string
  let iscp: DaemonIscpService
  let responder: WireResponder
  const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sess-new' }))
  const stopSession = vi.fn(() => true)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'iscp-wire-'))
    iscp = new DaemonIscpService((profileId) => join(root, profileId))
    responder = new WireResponder({
      iscp,
      profileId: 'p1',
      getChildren: () => [],
      stopSession,
      spawnSession,
    })
    spawnSession.mockClear()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('messages.send requires idempotencyKey and dedupes resends', async () => {
    const missing = await responder.handle({ id: 'r1', method: 'messages.send', params: { sessionId: 's1', body: { t: 'hi' } } })
    expect(missing).toMatchObject({ ok: false, error: { code: 'invalid' } })

    const first = await responder.handle({ id: 'r2', method: 'messages.send', params: { sessionId: 's1', body: { t: 'hi' } }, idempotencyKey: 'k1' })
    const retry = await responder.handle({ id: 'r3', method: 'messages.send', params: { sessionId: 's1', body: { t: 'hi' } }, idempotencyKey: 'k1' })
    expect(first).toMatchObject({ ok: true, result: { seq: 1, deduped: false } })
    expect(retry).toMatchObject({ ok: true, result: { seq: 1, deduped: true } })

    const pull = await responder.handle({ id: 'r4', method: 'messages.pull', params: { sessionId: 's1' } })
    expect(pull.ok).toBe(true)
    const result = (pull as { ok: true; result: { events: unknown[] } }).result
    expect(result.events).toHaveLength(1)
  })

  it('messages.pull resumes from a cursor and flags stale-epoch resets', async () => {
    await responder.handle({ id: 'a', method: 'messages.send', params: { sessionId: 's1', body: { n: 1 } }, idempotencyKey: 'k1' })
    await responder.handle({ id: 'b', method: 'messages.send', params: { sessionId: 's1', body: { n: 2 } }, idempotencyKey: 'k2' })
    const page1 = await responder.handle({ id: 'c', method: 'messages.pull', params: { sessionId: 's1', limit: 1 } })
    const r1 = (page1 as { ok: true; result: { events: Array<{ cursor: string }>; hasMore: boolean } }).result
    expect(r1.hasMore).toBe(true)

    const page2 = await responder.handle({ id: 'd', method: 'messages.pull', params: { sessionId: 's1', afterCursor: r1.events[0].cursor } })
    const r2 = (page2 as { ok: true; result: { events: Array<{ seq: number }>; reset: boolean } }).result
    expect(r2.events.map((e) => e.seq)).toEqual([2])
    expect(r2.reset).toBe(false)

    // Foreign/stale cursor → reset flag + full history from 0.
    const cursor = decodeWireCursor(r1.events[0].cursor)!
    const staleEpoch = r1.events[0].cursor.replace(cursor.epoch, 'other-epoch')
    const page3 = await responder.handle({ id: 'e', method: 'messages.pull', params: { sessionId: 's1', afterCursor: staleEpoch } })
    const r3 = (page3 as { ok: true; result: { events: unknown[]; reset: boolean } }).result
    expect(r3.reset).toBe(true)
    expect(r3.events).toHaveLength(2)
  })

  it('sessions.spawn injects HAPPY_NETWORK_PROFILE', async () => {
    const response = await responder.handle({ id: 's', method: 'sessions.spawn', params: { directory: '/tmp/proj' }, idempotencyKey: 'spawn-1' })
    expect(response).toMatchObject({ ok: true, result: { sessionId: 'sess-new' } })
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/proj',
      environmentVariables: { HAPPY_NETWORK_PROFILE: 'p1' },
    }))
  })

  it('rejects unknown methods as unsupported and keeps wakeup.v1 as a hook point', async () => {
    expect(await responder.handle({ id: 'x', method: 'nope', params: {} })).toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect(await responder.handle({ id: 'w', method: 'wakeup.v1', params: {} })).toMatchObject({ ok: false, error: { code: 'unsupported' } })
  })

  it('session.rpc returns not_found when the session bridge is offline', async () => {
    const response = await responder.handle({ id: 'r', method: 'session.rpc', params: { sessionId: 'ghost', method: 'abort', params: {} } })
    expect(response).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })
})
