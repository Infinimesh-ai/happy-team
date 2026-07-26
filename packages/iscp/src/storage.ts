/**
 * Injection seams for credential and state persistence.
 *
 * The package never picks a storage location on its own:
 * - happy-cli injects file-backed stores rooted at ~/.happy/iscp/<profileId>/
 *   (0700 dir, 0600 files) — see packages/happy-cli/src/iscp/enrollment.ts;
 * - happy-app (Phase 3) injects SecureStore for CredentialStore and MMKV for
 *   StateStore.
 *
 * CredentialStore holds secrets (identity seed, refresh credential, session
 * resumption keys). StateStore holds non-secret durable state (replay
 * windows, cursors, queued envelopes).
 */

export interface CredentialStore {
  getSecret(key: string): Promise<Uint8Array | null>;
  setSecret(key: string, value: Uint8Array): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly secrets = new Map<string, Uint8Array>();

  async getSecret(key: string): Promise<Uint8Array | null> {
    const value = this.secrets.get(key);
    return value ? new Uint8Array(value) : null;
  }

  async setSecret(key: string, value: Uint8Array): Promise<void> {
    this.secrets.set(key, new Uint8Array(value));
  }

  async deleteSecret(key: string): Promise<void> {
    this.secrets.delete(key);
  }
}

export class MemoryStateStore implements StateStore {
  private readonly state = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.state.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.state.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.state.delete(key);
  }
}
