/**
 * WebSocket seam: Node uses the `ws` package, React Native and modern Node
 * (>=22) expose a global WebSocket. The relay protocol authenticates in-band
 * (challenge/proof), so no headers are required and the browser-style
 * constructor surface is enough.
 */

export interface RawWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => RawWebSocket | Promise<RawWebSocket>;

/** Uses globalThis.WebSocket when present (RN, browser, Node >= 22), else the `ws` package. */
export const defaultWebSocketFactory: WebSocketFactory = async (url: string) => {
  const globalCtor = (globalThis as { WebSocket?: new (url: string) => RawWebSocket }).WebSocket;
  if (globalCtor) {
    return new globalCtor(url);
  }
  // Opaque specifier keeps React Native bundlers from trying to resolve `ws`.
  const specifier = 'ws';
  const wsModule = (await import(/* @vite-ignore */ specifier)) as { default: new (url: string) => RawWebSocket };
  return new wsModule.default(url);
};
