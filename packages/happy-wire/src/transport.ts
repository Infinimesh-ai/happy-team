import type { HappyWireRequest } from './wire/request';
import type { HappyWireEvent } from './wire/event';

/**
 * HappyTransport — the single port between the Happy domain layer and any
 * network stack. Two adapters implement it: LegacyHappyTransport (existing
 * account + Socket.IO/HTTP + Happy E2E) and ISCPHappyTransport (device
 * credential + SecureEnvelope, iscp_session_v1 protection). Domain code
 * depends on this interface only; the one sanctioned mode conditional lives
 * at the sync ingestion boundary that picks the event normalizer.
 *
 * Types only — this module must stay free of runtime dependencies so both
 * the app (RN/web) and the CLI (Node) can import it.
 */

export type HappyConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface HappyTransportRequestOptions {
  timeoutMs?: number;
}

export interface HappyTransport {
  connect(): Promise<void>;
  close(): Promise<void>;
  /**
   * Rejects with HappyWireRequestError on failure. Retries of mutations MUST
   * reuse the original request's idempotencyKey.
   */
  request<TResponse>(request: HappyWireRequest, options?: HappyTransportRequestOptions): Promise<TResponse>;
  /**
   * Single long-lived event stream. `fromCursor` resumes cursor-bearing
   * events after a disconnect; an unusable cursor (foreign, stale epoch)
   * makes the transport start from live state and the consumer re-syncs.
   * Legacy transport ignores the cursor (its sync engine tracks seq itself).
   */
  events(fromCursor?: string): AsyncIterable<HappyWireEvent>;
  connectionState(): HappyConnectionState;
  /** Push-style state changes for UI; returns an unsubscribe function. */
  onConnectionState(callback: (state: HappyConnectionState) => void): () => void;
}

/**
 * A network profile is the unit of identity, storage namespacing, and logout.
 * Exactly one is active at a time. A profile never mixes modes: legacy token
 * material and ISCP credentials are disjoint by construction, and wiping one
 * profile must not touch another's namespace (see inventory.md §namespace).
 */
export type HappyNetworkProfile =
  | {
      id: string;
      mode: 'legacy';
      accountId: string;
      serverUrl: string;
    }
  | {
      id: string;
      mode: 'iscp';
      deviceId: string;
      domainId: string;
      /** Reference into platform secure storage; never the credential itself. */
      credentialRef: string;
      relayHint?: string;
    };

export type HappyNetworkMode = HappyNetworkProfile['mode'];
