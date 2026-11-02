/**
 * HTTP webhook delivery (T13 production delivery function).
 *
 * The real {@link DeliveryFn} wired into the dispatcher in production: a single
 * HTTP POST of the snapshot payload to the subscriber's callback URL, with a
 * bounded timeout. Retry/backoff and drop-on-exhaustion are the dispatcher's
 * concern (Req 35.6–35.9); this function performs exactly one attempt and
 * reports success/failure.
 *
 * Uses the Node built-in global `fetch` (Node 18+) — no extra dependency. This
 * is deliberately a thin, replaceable seam: the Rust rewrite reimplements the
 * transport, so a minimal PoC-grade client is the right call here.
 *
 * Design reference: design.md § Webhook Dispatcher
 * Validates: Requirement 35.2
 */

import type { DeliveryFn, DeliveryResult } from './types.js';

/** Default per-attempt timeout (ms) for a webhook POST. */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Build an HTTP delivery function. A 2xx response is success; any non-2xx
 * status, network error, or timeout is a failure (the dispatcher then applies
 * fire-and-forget drop or retry/backoff). The payload is sent as JSON.
 */
export function createHttpDeliveryFn(timeoutMs: number = DEFAULT_DELIVERY_TIMEOUT_MS): DeliveryFn {
  return async (callbackUrl: string, payload: unknown): Promise<DeliveryResult> => {
    try {
      const response = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true, statusCode: response.status };
      }
      return { success: false, error: `HTTP ${response.status}`, statusCode: response.status };
    } catch (err) {
      // Network failure, DNS error, or the AbortSignal timeout firing.
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  };
}
