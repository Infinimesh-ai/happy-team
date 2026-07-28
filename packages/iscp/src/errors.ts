/**
 * ISCP error model v2 (spec/errors.md, schemas/json/error.v2.json).
 *
 * Details MUST NOT contain private keys, access token plaintext, refresh
 * credential plaintext, session keys, or plaintext payloads — the redaction
 * test in noSecretLeak.test.ts enforces this for everything this package
 * constructs.
 */

export const IscpErrorCodes = {
  CanonicalInvalid: 'ISCPCAN001',
  SchemaInvalid: 'ISCPCAN002',
  SignatureInvalid: 'ISCPSIG001',
  KeyInvalid: 'ISCPKEY001',
  TrustInvalid: 'ISCPTRUST001',
  SessionInvalid: 'ISCPSESSION001',
  EnvelopeInvalid: 'ISCPENV001',
  ReplayDetected: 'ISCPENV002',
  AccessInvalid: 'ISCPACCESS001',
  ProvisionInvalid: 'ISCPPROV001',
  ConfigInvalid: 'ISCPCFG001',
  StorageInvalid: 'ISCPDB001',
} as const;

export type IscpErrorCode = (typeof IscpErrorCodes)[keyof typeof IscpErrorCodes];

export class IscpError extends Error {
  readonly code: IscpErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, string>;
  readonly requestId?: string;

  constructor(
    code: IscpErrorCode,
    message: string,
    opts?: { retryable?: boolean; details?: Record<string, string>; requestId?: string; cause?: unknown },
  ) {
    super(`${code}: ${message}`, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'IscpError';
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.details = opts?.details;
    this.requestId = opts?.requestId;
  }

  toWire(): { type: 'iscp.error.v2'; code: string; message: string; retryable: boolean; request_id?: string; details?: Record<string, string> } {
    return {
      type: 'iscp.error.v2',
      code: this.code,
      // Strip the code prefix Error() adds to message for wire form.
      message: this.message.startsWith(`${this.code}: `) ? this.message.slice(this.code.length + 2) : this.message,
      retryable: this.retryable,
      ...(this.requestId !== undefined ? { request_id: this.requestId } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function iscpError(code: IscpErrorCode, message: string, opts?: { retryable?: boolean; details?: Record<string, string>; cause?: unknown }): IscpError {
  return new IscpError(code, message, opts);
}

/** Parse an iscp.error.v2 wire object into an IscpError; falls back to AccessInvalid. */
export function iscpErrorFromWire(value: unknown, fallbackMessage: string): IscpError {
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (obj.type === 'iscp.error.v2' && typeof obj.code === 'string' && typeof obj.message === 'string') {
      const known = Object.values(IscpErrorCodes).find((c) => c === obj.code);
      return new IscpError(known ?? IscpErrorCodes.AccessInvalid, obj.message, {
        retryable: obj.retryable === true,
        requestId: typeof obj.request_id === 'string' ? obj.request_id : undefined,
      });
    }
  }
  return new IscpError(IscpErrorCodes.AccessInvalid, fallbackMessage);
}
