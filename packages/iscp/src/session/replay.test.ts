import { describe, expect, it } from 'vitest';

import { MemoryStateStore } from '../storage';
import { InMemoryReplayStore, PersistentReplayStore } from './replay';

describe('replay stores', () => {
  it('InMemoryReplayStore rejects duplicate sequences and nonces independently', () => {
    const store = new InMemoryReplayStore();
    expect(store.isReplay(0, 'n0')).toBe(false);
    store.record(0, 'n0');
    expect(store.isReplay(0, 'other')).toBe(true); // duplicate sequence
    expect(store.isReplay(1, 'n0')).toBe(true); // duplicate nonce
    expect(store.isReplay(1, 'n1')).toBe(false);
  });

  it('PersistentReplayStore survives a reload (daemon restart scenario)', async () => {
    const stateStore = new MemoryStateStore();
    const first = await PersistentReplayStore.load(stateStore, 'session-1/recv');
    first.record(0, 'n0');
    first.record(1, 'n1');
    await first.flush();

    const reloaded = await PersistentReplayStore.load(stateStore, 'session-1/recv');
    expect(reloaded.isReplay(0, 'nX')).toBe(true);
    expect(reloaded.isReplay(5, 'n1')).toBe(true);
    expect(reloaded.isReplay(2, 'n2')).toBe(false);
  });

  it('keys are namespaced: another session is unaffected', async () => {
    const stateStore = new MemoryStateStore();
    const a = await PersistentReplayStore.load(stateStore, 'session-a/recv');
    a.record(0, 'n0');
    await a.flush();
    const b = await PersistentReplayStore.load(stateStore, 'session-b/recv');
    expect(b.isReplay(0, 'n0')).toBe(false);
  });
});
