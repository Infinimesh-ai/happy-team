import * as z from 'zod';

/**
 * Provider-neutral error model shared by every HappyTransport implementation.
 * Transports map their native failures (HTTP status, socket errors, ISCP auth
 * failures) onto these codes; domain code only ever branches on `code`.
 */
export const HappyWireErrorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'invalid',
  'retryable',
  'timeout',
  'unsupported',
]);
export type HappyWireErrorCode = z.infer<typeof HappyWireErrorCodeSchema>;

export const HappyWireErrorSchema = z.object({
  code: HappyWireErrorCodeSchema,
  message: z.string(),
  retryAfterMs: z.number().optional(),
});
export type HappyWireError = z.infer<typeof HappyWireErrorSchema>;

export class HappyWireRequestError extends Error {
  readonly code: HappyWireErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(error: HappyWireError) {
    super(error.message);
    this.name = 'HappyWireRequestError';
    this.code = error.code;
    this.retryAfterMs = error.retryAfterMs;
  }

  get retryable(): boolean {
    return this.code === 'retryable' || this.code === 'timeout';
  }
}
