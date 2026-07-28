/**
 * ISCP-mode session RPC server: a localhost HTTP endpoint each ISCP session
 * process exposes so the daemon's wire responder can bridge happy-wire.v1
 * requests (session.rpc, user message delivery) to the session's existing
 * RpcHandlerManager — plaintext over 127.0.0.1; the E2E leg is
 * iscp_session_v1 on the relay.
 *
 * The session registers its port with the daemon control server
 * (POST /iscp/session-rpc) right after listening, and re-registers with
 * retries so a daemon restart re-learns the port.
 */

import fastify from 'fastify'
import { z } from 'zod'
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod'

import { daemonPost } from '@/daemon/controlClient'
import { logger } from '@/ui/logger'
import { delay } from '@/utils/time'

const REGISTER_RETRY_INTERVAL_MS = 2000
const REGISTER_RETRY_LIMIT = 30

export const USER_MESSAGE_METHOD = 'iscp.user-message'

export interface IscpSessionRpcServer {
  port: number
  stop: () => Promise<void>
}

export async function startIscpSessionRpcServer(opts: {
  profileId: string
  sessionId: string
  onUserMessage: (body: unknown) => void
  callHandler: (method: string, params: unknown) => Promise<unknown>
}): Promise<IscpSessionRpcServer> {
  const app = fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.post('/rpc', {
    schema: {
      body: z.object({
        method: z.string().min(1),
        params: z.unknown()
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown()
        }),
        500: z.object({
          ok: z.literal(false),
          error: z.string()
        })
      }
    }
  }, async (request, reply) => {
    const { method, params } = request.body
    try {
      if (method === USER_MESSAGE_METHOD) {
        opts.onUserMessage(params)
        return { ok: true as const, result: null }
      }
      const result = await opts.callHandler(method, params)
      return { ok: true as const, result: result ?? null }
    } catch (error) {
      reply.code(500)
      return { ok: false as const, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  const port = await new Promise<number>((resolve, reject) => {
    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        reject(err)
        return
      }
      resolve(parseInt(address.split(':').pop()!))
    })
  })
  logger.debug(`[ISCP SESSION RPC] Listening on 127.0.0.1:${port} for session ${opts.sessionId}`)

  // Register with the daemon (retry: we may race a daemon restart).
  void (async () => {
    for (let attempt = 0; attempt < REGISTER_RETRY_LIMIT; attempt++) {
      const result = await daemonPost('/iscp/session-rpc', {
        profileId: opts.profileId,
        sessionId: opts.sessionId,
        port
      })
      if (!result?.error) {
        logger.debug(`[ISCP SESSION RPC] Registered with daemon for session ${opts.sessionId}`)
        return
      }
      await delay(REGISTER_RETRY_INTERVAL_MS)
    }
    logger.debug(`[ISCP SESSION RPC] Failed to register with daemon for session ${opts.sessionId}`)
  })()

  return {
    port,
    stop: async () => {
      await app.close()
    }
  }
}
