/**
 * SecureEnvelope payload_type values for Happy-over-ISCP. After the
 * agent.capability.v1 manifest exchange, every business payload is one of:
 *
 * - request/response: HappyWireRequest / HappyWireResponse JSON (UTF-8);
 * - event: cursor-bearing HappyWireEvent ('session-event' / 'machine-event');
 * - ephemeral: lossy HappyWireEvent 'ephemeral' (activity/typing), no cursor.
 */
export const WIRE_REQUEST_PAYLOAD_TYPE = 'happy/wire-request.v1';
export const WIRE_RESPONSE_PAYLOAD_TYPE = 'happy/wire-response.v1';
export const WIRE_EVENT_PAYLOAD_TYPE = 'happy/wire-event.v1';
export const WIRE_EPHEMERAL_PAYLOAD_TYPE = 'happy/wire-ephemeral.v1';
