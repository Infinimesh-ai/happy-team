/**
 * Per-direction sequence + nonce replay protection for SecureEnvelope
 * receive paths (spec/envelope.md: "Receivers track sequence numbers and
 * nonce values per session direction. A duplicate sequence or nonce is
 * rejected.").
 *
 * The hot path is synchronous; persistence is a hook so a daemon or app can
 * survive restarts without accepting replays.
 */

import type { StateStore } from '../storage';

export interface ReplayStore {
  /** True if the sequence or nonce was already seen for this direction. */
  isReplay(sequence: number, nonce: string): boolean;
  /** Record a delivered sequence + nonce. */
  record(sequence: number, nonce: string): void;
}

export class InMemoryReplayStore implements ReplayStore {
  protected readonly seenSequences = new Set<number>();
  protected readonly seenNonces = new Set<string>();

  isReplay(sequence: number, nonce: string): boolean {
    return this.seenSequences.has(sequence) || this.seenNonces.has(nonce);
  }

  record(sequence: number, nonce: string): void {
    this.seenSequences.add(sequence);
    this.seenNonces.add(nonce);
  }
}

interface PersistedReplayWindow {
  sequences: number[];
  nonces: string[];
}

/**
 * ReplayStore persisted through a StateStore. Load once with
 * `PersistentReplayStore.load(...)`; each `record` schedules an async write
 * (last-write-wins per key, writes are serialized).
 */
export class PersistentReplayStore extends InMemoryReplayStore {
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly stateStore: StateStore,
    private readonly key: string,
    private readonly onPersistError?: (error: unknown) => void,
  ) {
    super();
  }

  static async load(stateStore: StateStore, key: string, onPersistError?: (error: unknown) => void): Promise<PersistentReplayStore> {
    const store = new PersistentReplayStore(stateStore, key, onPersistError);
    const raw = await stateStore.get(key);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as PersistedReplayWindow;
      for (const seq of parsed.sequences) store.seenSequences.add(seq);
      for (const nonce of parsed.nonces) store.seenNonces.add(nonce);
    }
    return store;
  }

  override record(sequence: number, nonce: string): void {
    super.record(sequence, nonce);
    const snapshot: PersistedReplayWindow = {
      sequences: [...this.seenSequences],
      nonces: [...this.seenNonces],
    };
    this.writeChain = this.writeChain
      .then(() => this.stateStore.set(this.key, JSON.stringify(snapshot)))
      .catch((error) => this.onPersistError?.(error));
  }

  /** Await outstanding persistence writes (for orderly shutdown/tests). */
  flush(): Promise<void> {
    return this.writeChain;
  }
}
