/**
 * End-to-end tests for the 0.6.0 subscription → webhook delivery pipeline.
 *
 * These exercise the wiring that `src/index.ts` `main()` installs: the
 * `onDocumentStored` hook fans out to `subscriptionManager.createWebhookJobs`
 * (node-scoped by writtenPaths, Req 38.1a), enqueues the jobs on the dispatcher
 * (snapshot-at-enqueue, Req 35.11), and a pump drains the queue via
 * `processNext` using a real-shaped delivery function.
 *
 * To keep assertions deterministic we drive `processNext` directly instead of
 * the interval timer, and inject a capturing delivery function instead of a
 * real HTTP call (the HTTP client itself is covered separately).
 *
 * Validates: Req 35.2/35.11-13, 37.5b, 37.10, 38.1/38.1a, 32.4/32.5.
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/storage/memory-store.js';
import { SchemaManagerImpl } from '../src/schema/schema-manager.js';
import { DocumentTypeRegistryImpl } from '../src/document-type/document-type-registry.js';
import { DIdExtractorImpl } from '../src/did/did-extractor.js';
import { VersionManagerImpl } from '../src/version/version-manager.js';
import { EnrichmentEngineImpl } from '../src/enrichment/enrichment-engine.js';
import { DocumentManagerImpl } from '../src/document-manager/document-manager.js';
import { QueryEngineImpl } from '../src/query/query-engine.js';
import { TtlManagerImpl } from '../src/ttl/ttl-manager.js';
import { SubscriptionManagerImpl } from '../src/subscription/subscription-manager.js';
import { WebhookDispatcherImpl } from '../src/webhook/webhook-dispatcher.js';
import type { ChannelResolution } from '../src/channel/types.js';
import type { DeliveryResult } from '../src/webhook/types.js';

/**
 * Build a stack wired exactly as main() wires the delivery pipeline, with a
 * capturing delivery function. `deliveries` records every (url, payload)
 * actually delivered; `drain()` runs the pump to completion synchronously.
 */
function createPipeline(deliveryResult: DeliveryResult = { success: true, statusCode: 200 }) {
  const storage = new MemoryStore();
  const schemaManager = new SchemaManagerImpl();
  const docTypeRegistry = new DocumentTypeRegistryImpl();
  const didExtractor = new DIdExtractorImpl();
  const versionManager = new VersionManagerImpl();
  const enrichmentEngine = new EnrichmentEngineImpl();
  const queryEngine = new QueryEngineImpl(storage);
  const ttlManager = new TtlManagerImpl();
  const subscriptionManager = new SubscriptionManagerImpl();
  const webhookDispatcher = new WebhookDispatcherImpl();

  const documentManager = new DocumentManagerImpl({
    storage, schemaManager, docTypeRegistry, enrichmentEngine, didExtractor, versionManager,
  });

  schemaManager.register({
    ref: 'order-v1',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', identityKind: 'primary-key' },
        A: { type: 'string' },
        B: { type: 'string' },
        C: { type: 'string' },
        location: { type: 'object', properties: { room: { type: 'string' }, floor: { type: 'number' } } },
      },
      required: ['id'],
    },
  });
  docTypeRegistry.register({ name: 'orders', masterSchema: 'order-v1', model: 'hybrid' });

  const resolution: ChannelResolution = { documentType: 'orders', applicableSchema: 'order-v1', source: 'url' };

  const deliveries: { url: string; payload: unknown }[] = [];
  webhookDispatcher.setDeliveryFn(async (url, payload) => {
    deliveries.push({ url, payload });
    return deliveryResult;
  });

  // Mirror main()'s onDocumentStored fan-out (TTL arming + subscription enqueue).
  documentManager.setHooks({
    onDocumentStored: (documentType, dId, document, writtenPaths) => {
      const effectiveTtl = document.ttl ?? ttlManager.getEffectiveTtl(documentType, dId);
      const lastUpdateTime =
        document.timestampList[document.timestampList.length - 1]?.requestTime ?? document.creationTime;
      ttlManager.registerExpiry(documentType, dId, lastUpdateTime, effectiveTtl, document.expireAt);

      const projected = queryEngine.renderStoredDocument(document);
      const jobs = subscriptionManager.createWebhookJobs(projected, documentType, dId, writtenPaths);
      for (const job of jobs) {
        const { options } = job.subscription;
        webhookDispatcher.enqueue({
          subscriptionId: job.subscriptionId,
          dId: job.dId,
          documentType: job.documentType,
          payload: job.payload,
          callbackUrl: job.subscription.callbackUrl,
          enqueuedAt: job.enqueuedAt,
          deliveryMode: options.deliveryMode,
          ...(document.expireAt !== undefined
            ? { expireAt: document.expireAt, expiryMode: 'hard-cutoff' as const }
            : {}),
        });
      }
    },
  });

  async function drain(now?: string): Promise<void> {
    while (await webhookDispatcher.processNext(now)) {
      // keep draining ready jobs
    }
  }

  return { storage, documentManager, subscriptionManager, webhookDispatcher, resolution, deliveries, drain, ttlManager };
}

const dId = { type: 'single' as const, value: '1' };

// ─── Core: store → enqueue → deliver ────────────────────────────────────────

describe('Delivery pipeline (Req 35.2)', () => {
  it('delivers to a Document_Type subscriber when a matching doc is stored', async () => {
    const p = createPipeline();
    p.subscriptionManager.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'https://sink/t' });

    p.documentManager.store({ document: { id: 1, A: 'x' } }, p.resolution);
    expect(p.webhookDispatcher.pendingCount()).toBe(1); // enqueued synchronously in the store hook
    await p.drain();

    expect(p.deliveries).toHaveLength(1);
    expect(p.deliveries[0]?.url).toBe('https://sink/t');
  });

  it('delivers to a D-Id subscriber and carries the dId wire form in the envelope', async () => {
    const p = createPipeline();
    p.subscriptionManager.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'https://sink/d' });

    p.documentManager.store({ document: { id: 1, A: 'x' } }, p.resolution);
    await p.drain();

    expect(p.deliveries).toHaveLength(1);
    const envelope = p.deliveries[0]?.payload as Record<string, unknown>;
    expect(envelope['dId']).toBe('1'); // wire form (bare string), not { type, value }
    expect(envelope['documentType']).toBe('orders');
    expect((envelope['document'] as Record<string, unknown>)['A']).toBe('x');
  });

  it('does not deliver when no subscription matches', async () => {
    const p = createPipeline();
    p.documentManager.store({ document: { id: 1, A: 'x' } }, p.resolution);
    await p.drain();
    expect(p.deliveries).toHaveLength(0);
  });
});

// ─── Node-scoped triggering through the real store pipeline (Req 38.1a) ──────

describe('Node-scoped triggering end-to-end (Req 38.1a)', () => {
  it('a write touching A and B fires a sub on B but not a sub on C', async () => {
    const p = createPipeline();
    p.documentManager.store({ document: { id: 1, A: 'a0', B: 'b0', C: 'c0' } }, p.resolution); // create
    p.subscriptionManager.subscribe({ scope: 'document_id', documentType: 'orders', dId, path: 'B', callbackUrl: 'https://sink/B' });
    p.subscriptionManager.subscribe({ scope: 'document_id', documentType: 'orders', dId, path: 'C', callbackUrl: 'https://sink/C' });

    // Merge write touching only A and B.
    p.documentManager.store({ document: { id: 1, A: 'a1', B: 'b1' } }, p.resolution);
    await p.drain();

    const urls = p.deliveries.map((d) => d.url);
    expect(urls).toContain('https://sink/B');
    expect(urls).not.toContain('https://sink/C');
  });

  it('re-sending a leaf with an identical value still triggers (content-agnostic, Req 38.1)', async () => {
    const p = createPipeline();
    p.documentManager.store({ document: { id: 1, B: 'same' } }, p.resolution); // create
    p.subscriptionManager.subscribe({ scope: 'document_id', documentType: 'orders', dId, path: 'B', callbackUrl: 'https://sink/B' });

    p.documentManager.store({ document: { id: 1, B: 'same' } }, p.resolution); // identical value
    await p.drain();
    expect(p.deliveries.map((d) => d.url)).toContain('https://sink/B');
  });

  it('a bunch-path sub fires when a nested leaf within it is written', async () => {
    const p = createPipeline();
    p.documentManager.store({ document: { id: 1, location: { room: 'r0', floor: 1 } } }, p.resolution);
    p.subscriptionManager.subscribe({ scope: 'document_id', documentType: 'orders', dId, path: 'location', callbackUrl: 'https://sink/loc' });

    p.documentManager.store({ document: { id: 1, location: { room: 'r1' } } }, p.resolution);
    await p.drain();
    expect(p.deliveries.map((d) => d.url)).toContain('https://sink/loc');
  });
});

// ─── Snapshot-at-enqueue (Req 35.11-13) ──────────────────────────────────────

describe('Snapshot-at-enqueue (Req 35.11)', () => {
  it('captures the payload at store time; a later store does not mutate an enqueued job', async () => {
    const p = createPipeline();
    p.subscriptionManager.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'https://sink/d' });

    p.documentManager.store({ document: { id: 1, A: 'first' } }, p.resolution);
    // A second store before draining enqueues a SECOND job; the first job's
    // snapshot must still reflect 'first'.
    p.documentManager.store({ document: { id: 1, A: 'second' } }, p.resolution);
    await p.drain();

    const firstDoc = (p.deliveries[0]?.payload as Record<string, unknown>)['document'] as Record<string, unknown>;
    const secondDoc = (p.deliveries[1]?.payload as Record<string, unknown>)['document'] as Record<string, unknown>;
    expect(firstDoc['A']).toBe('first');
    expect(secondDoc['A']).toBe('second');
  });
});

// ─── TTL=0 still triggers (Req 37.5b) ────────────────────────────────────────

describe('TTL=0 triggering (Req 37.5b)', () => {
  it('a TTL=0 document still enqueues and delivers before its transient removal', async () => {
    const p = createPipeline();
    p.subscriptionManager.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'https://sink/d' });

    // TTL=0: the store hook runs the fan-out synchronously (subscriptions fire)
    // before any sweep/on-access soft-delete removes the transient doc.
    p.documentManager.store({ document: { id: 1, A: 'x' }, ttl: 0 }, p.resolution);
    expect(p.webhookDispatcher.pendingCount()).toBe(1);
    await p.drain();
    expect(p.deliveries).toHaveLength(1);
  });
});

// ─── Retry / fire-and-forget delivery semantics (Req 35.6-9) ─────────────────

describe('Delivery modes (Req 35.6-9)', () => {
  it('fire-and-forget drops on failure after a single attempt', async () => {
    const p = createPipeline({ success: false, error: 'boom' });
    p.subscriptionManager.subscribe({
      scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'https://sink/d',
      options: { deliveryMode: 'fire-and-forget', payloadFormat: 'envelope', retrievalMode: 'full', schemaAdoptionMode: 'pinned', includeMetadata: false },
    });
    p.documentManager.store({ document: { id: 1, A: 'x' } }, p.resolution);
    await p.drain();
    expect(p.deliveries).toHaveLength(1); // attempted once
    expect(p.webhookDispatcher.pendingCount()).toBe(0); // dropped, not retried
  });

  it('retry mode reschedules with backoff after a failure (job stays until exhausted)', async () => {
    const p = createPipeline({ success: false, error: 'boom' });
    p.subscriptionManager.subscribe({
      scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'https://sink/d',
      options: { deliveryMode: 'retry', payloadFormat: 'envelope', retrievalMode: 'full', schemaAdoptionMode: 'pinned', includeMetadata: false },
    });
    p.documentManager.store({ document: { id: 1, A: 'x' } }, p.resolution);
    // First attempt at t0 fails → rescheduled for t0+1s; not yet dropped.
    const r = await p.webhookDispatcher.processNext('2026-01-01T00:00:00.000Z');
    expect(r?.job.status).toBe('pending');
    expect(r?.job.nextAttemptAt).toBe('2026-01-01T00:00:01.000Z');
  });
});
