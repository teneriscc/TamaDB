/**
 * Subscription jobs → dispatcher queue.
 *
 * The Subscription Manager and the Webhook Dispatcher each have their own
 * `WebhookJob` shape (the first is a formatted snapshot tied to its
 * subscription; the second is a queue entry with delivery bookkeeping). This is
 * the single bridge between them, used by the production bootstrap and by the
 * pipeline tests alike, so the two cannot drift.
 *
 * Design reference: working note `webhook-raw-default-and-headers.md`
 * Validates: Requirements 35.2, 35.5c, 35.11-13, 37.12c-d
 */

import type { WebhookJob as SubscriptionJob } from '../subscription/types.js';
import type { WebhookDispatcher } from './types.js';
import { buildDeliveryHeaders } from './delivery-headers.js';

export interface EnqueueOptions {
  /** The source document's Expire-at-Point-in-Time, if any. */
  readonly expireAt?: string | undefined;
  /** The composed-D-Id delimiter used in the `TamaDB-D-Id` header. */
  readonly dIdDelimiter: string;
}

/**
 * Enqueue the jobs a store produced. The payload (and the delivery-context
 * headers) were captured when the jobs were created — snapshot-at-enqueue
 * (Req 35.11) — so nothing here re-reads the document.
 */
export function enqueueSubscriptionJobs(
  dispatcher: WebhookDispatcher,
  jobs: readonly SubscriptionJob[],
  options: EnqueueOptions,
): void {
  for (const job of jobs) {
    const { subscription } = job;
    dispatcher.enqueue({
      subscriptionId: job.subscriptionId,
      dId: job.dId,
      documentType: job.documentType,
      payload: job.payload,
      callbackUrl: subscription.callbackUrl,
      enqueuedAt: job.enqueuedAt,
      deliveryMode: subscription.options.deliveryMode,
      headers: buildDeliveryHeaders({
        subscriptionId: job.subscriptionId,
        documentType: job.documentType,
        dId: job.dId,
        path: subscription.path,
        enqueuedAt: job.enqueuedAt,
        dIdDelimiter: options.dIdDelimiter,
      }),
      // Expire-at-Point-in-Time enforcement on in-flight deliveries
      // (Req 35.13 / 37.12c): carry the document's Expire-At onto the job so
      // hard-cutoff suppression can apply. The per-document enforcement mode
      // defaults to hard-cutoff (Req 37.12d); a configuration surface for
      // enqueue-cutoff is deferred (no ingestion header for it yet).
      ...(options.expireAt !== undefined
        ? { expireAt: options.expireAt, expiryMode: 'hard-cutoff' as const }
        : {}),
    });
  }
}
