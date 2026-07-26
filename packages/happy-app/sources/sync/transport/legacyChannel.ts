/**
 * Surface that exists only on the legacy transport: raw HTTP against
 * happy-server, socket side-channels, and token rotation. On the ISCP
 * transport `legacy` is undefined, which is the compile-time guard that keeps
 * legacy-only features (feed, friends, github, attachments, push registration)
 * from being reached in ISCP mode. See docs/network-dual-stack/inventory.md.
 */
export interface LegacyChannel {
    /** Authenticated HTTP request against the legacy server (Bearer + X-Happy-Client). */
    request(path: string, options?: RequestInit): Promise<Response>;
    /** Focus state for server-side push suppression. Safe no-op when disconnected. */
    sendAppState(state: string): void;
    emitWithAck<T = any>(event: string, data: any): Promise<T>;
    send(event: string, data: any): boolean;
    updateToken(newToken: string): void;
    /**
     * Fires after a non-recovered reconnect; legacy sync uses it to invalidate
     * everything. The ISCP transport has no equivalent — recovery there is
     * cursor-driven via events(fromCursor).
     */
    onReconnected(listener: () => void): () => void;
}
