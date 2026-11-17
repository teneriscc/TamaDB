/**
 * Webhook delivery-context headers.
 *
 * Every webhook POST carries TamaDB's delivery context as `TamaDB-*` HTTP
 * headers, whatever the subscription's `payloadFormat`. The body stays the pure
 * document the subscriber asked for (shaped by its Retrieval_Schema, if any);
 * the headers say which subscription fired, for which document, and when. This
 * mirrors the ingest side, where the body is the bare document and per-request
 * instructions travel as `TamaDB-*` Control_Headers — producers AND consumers
 * stay agnostic of TamaDB's metadata (working spec §12, Req 1.10, Req 34.15).
 *
 * Header values are restricted to what is safe in an HTTP header: the document
 * type, D-Id and path are percent-encoded exactly as they are in URL path
 * segments, so a consumer can decode them with `decodeURIComponent` (and split a
 * composed D-Id on the delimiter first).
 *
 * Design reference: working note `webhook-raw-default-and-headers.md`
 * Validates: Requirement 35.5b/35.5c
 */

import type { DocumentIdentifier } from '../storage/types.js';
import { dIdToUrl } from '../api/context.js';

/** Header names — one place, so docs, tests and code cannot drift. */
export const DELIVERY_HEADERS = {
  subscriptionId: 'TamaDB-Subscription-Id',
  documentType: 'TamaDB-Document-Type',
  dId: 'TamaDB-D-Id',
  path: 'TamaDB-Path',
  enqueuedAt: 'TamaDB-Enqueued-At',
} as const;

export interface DeliveryContext {
  readonly subscriptionId: string;
  readonly documentType: string;
  readonly dId: DocumentIdentifier;
  /** The subscription's node-scoped path, if it has one (Req 38.1a). */
  readonly path?: string | undefined;
  /** When the delivery snapshot was captured (ISO-8601 UTC). */
  readonly enqueuedAt: string;
  /** The composed-D-Id delimiter (instance-level, default `:`). */
  readonly dIdDelimiter: string;
}

/**
 * Build the delivery-context headers for one webhook job.
 *
 * - `TamaDB-Subscription-Id` — the subscription that matched the write.
 * - `TamaDB-Document-Type` — percent-encoded Document_Type name.
 * - `TamaDB-D-Id` — the document identity in URL form (percent-encoded parts,
 *   composed parts joined by the delimiter).
 * - `TamaDB-Path` — percent-encoded node path; present ONLY for a node-scoped
 *   subscription.
 * - `TamaDB-Enqueued-At` — when the snapshot was captured (not the document's
 *   own timestamps, which are stored metadata and not delivered).
 */
export function buildDeliveryHeaders(ctx: DeliveryContext): Record<string, string> {
  const headers: Record<string, string> = {
    [DELIVERY_HEADERS.subscriptionId]: ctx.subscriptionId,
    [DELIVERY_HEADERS.documentType]: encodeURIComponent(ctx.documentType),
    [DELIVERY_HEADERS.dId]: dIdToUrl(ctx.dId, ctx.dIdDelimiter),
    [DELIVERY_HEADERS.enqueuedAt]: ctx.enqueuedAt,
  };
  if (ctx.path) {
    headers[DELIVERY_HEADERS.path] = encodeURIComponent(ctx.path);
  }
  return headers;
}
