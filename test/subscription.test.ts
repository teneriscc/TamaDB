/**
 * Unit tests for Component 12: Subscription Manager
 *
 * Covers T12.1 (creation), T12.2 (options), T12.3 (cancellation),
 * T12.4 (listing), T12.5 (event matching), T12.6 (payload formatting),
 * T12.7 (snapshot-at-enqueue), T12.8 (auto-cancel on explicit delete),
 * T12.9 (no auto-cancel on TTL delete), T12.10 (schema adoption).
 */

import { describe, it, expect } from 'vitest';
import { SubscriptionManagerImpl } from '../src/subscription/subscription-manager.js';
import type { DocumentIdentifier } from '../src/storage/types.js';

function setup() {
  return new SubscriptionManagerImpl();
}

const dId: DocumentIdentifier = { type: 'single', value: 'order-1' };

// ─── T12.1: Subscription Creation ──────────────────────────────────────────

describe('T12.1: Subscription Creation', () => {
  it('creates a Document_Type-level subscription', () => {
    const mgr = setup();
    const sub = mgr.subscribe({
      scope: 'document_type',
      documentType: 'orders',
      callbackUrl: 'https://consumer.example.com/webhook',
    });
    expect(sub.id).toBeTruthy();
    expect(sub.scope).toBe('document_type');
    expect(sub.documentType).toBe('orders');
    expect(sub.active).toBe(true);
  });

  it('creates a D-Id-level subscription', () => {
    const mgr = setup();
    const sub = mgr.subscribe({
      scope: 'document_id',
      documentType: 'orders',
      dId,
      callbackUrl: 'https://consumer.example.com/webhook',
    });
    expect(sub.scope).toBe('document_id');
    expect(sub.dId).toEqual(dId);
  });

  it('supports subscriptions on non-existent D-Ids', () => {
    const mgr = setup();
    const sub = mgr.subscribe({
      scope: 'document_id',
      documentType: 'orders',
      dId: { type: 'single', value: 'not-yet-created' },
      callbackUrl: 'https://example.com/hook',
    });
    expect(sub.active).toBe(true);
  });

  it('assigns unique subscription IDs', () => {
    const mgr = setup();
    const sub1 = mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url1' });
    const sub2 = mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url2' });
    expect(sub1.id).not.toBe(sub2.id);
  });
});

// ─── T12.2: Subscription Options ────────────────────────────────────────────

describe('T12.2: Options', () => {
  it('applies default options', () => {
    const mgr = setup();
    const sub = mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url' });
    expect(sub.options.retrievalMode).toBe('full');
    expect(sub.options.schemaAdoptionMode).toBe('pinned');
    expect(sub.options.payloadFormat).toBe('envelope');
    expect(sub.options.deliveryMode).toBe('fire-and-forget');
    expect(sub.options.includeMetadata).toBe(false);
  });

  it('accepts custom options', () => {
    const mgr = setup();
    const sub = mgr.subscribe({
      scope: 'document_type',
      documentType: 'orders',
      callbackUrl: 'url',
      options: {
        retrievalMode: 'closed',
        payloadFormat: 'raw',
        deliveryMode: 'retry',
        schemaAdoptionMode: 'propagate',
        includeMetadata: true,
      },
    });
    expect(sub.options.retrievalMode).toBe('closed');
    expect(sub.options.payloadFormat).toBe('raw');
    expect(sub.options.deliveryMode).toBe('retry');
    expect(sub.options.schemaAdoptionMode).toBe('propagate');
    expect(sub.options.includeMetadata).toBe(true);
  });
});

// ─── T12.3: Cancellation ────────────────────────────────────────────────────

describe('T12.3: Cancellation', () => {
  it('cancels a subscription by ID', () => {
    const mgr = setup();
    const sub = mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url' });
    expect(mgr.unsubscribe(sub.id)).toBe(true);
    expect(mgr.get(sub.id)).toBeUndefined();
  });

  it('returns false for non-existent ID', () => {
    const mgr = setup();
    expect(mgr.unsubscribe('nope')).toBe(false);
  });
});

// ─── T12.4: Listing ─────────────────────────────────────────────────────────

describe('T12.4: Listing', () => {
  it('lists by Document_Type', () => {
    const mgr = setup();
    mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url1' });
    mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url2' });
    mgr.subscribe({ scope: 'document_type', documentType: 'customers', callbackUrl: 'url3' });

    expect(mgr.listByDocumentType('orders')).toHaveLength(2);
    expect(mgr.listByDocumentType('customers')).toHaveLength(1);
  });

  it('lists by D-Id', () => {
    const mgr = setup();
    mgr.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'url1' });
    mgr.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'url2' });

    expect(mgr.listByDocumentId('orders', dId)).toHaveLength(2);
  });

  it('excludes cancelled subscriptions from listing', () => {
    const mgr = setup();
    const sub = mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url' });
    mgr.unsubscribe(sub.id);
    expect(mgr.listByDocumentType('orders')).toHaveLength(0);
  });
});

// ─── T12.5: Event Matching ──────────────────────────────────────────────────

describe('T12.5: Event Matching', () => {
  it('matches Document_Type-level subscriptions', () => {
    const mgr = setup();
    mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url' });
    const matched = mgr.findMatching('orders', dId);
    expect(matched).toHaveLength(1);
  });

  it('matches D-Id-level subscriptions', () => {
    const mgr = setup();
    mgr.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'url' });
    const matched = mgr.findMatching('orders', dId);
    expect(matched).toHaveLength(1);
  });

  it('matches both levels simultaneously', () => {
    const mgr = setup();
    mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url1' });
    mgr.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'url2' });
    const matched = mgr.findMatching('orders', dId);
    expect(matched).toHaveLength(2);
  });

  it('does not match different Document_Type', () => {
    const mgr = setup();
    mgr.subscribe({ scope: 'document_type', documentType: 'customers', callbackUrl: 'url' });
    const matched = mgr.findMatching('orders', dId);
    expect(matched).toHaveLength(0);
  });

  it('does not match different D-Id', () => {
    const mgr = setup();
    mgr.subscribe({ scope: 'document_id', documentType: 'orders', dId: { type: 'single', value: 'other' }, callbackUrl: 'url' });
    const matched = mgr.findMatching('orders', dId);
    expect(matched).toHaveLength(0);
  });
});

// ─── T12.6: Payload Formatting ──────────────────────────────────────────────

describe('T12.6: Payload Formatting', () => {
  it('envelope format includes context', () => {
    const mgr = setup();
    const sub = mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url' });
    const payload = mgr.formatPayload({ name: 'Test', amount: 100 }, sub, dId, 'orders') as Record<string, unknown>;
    expect(payload['subscriptionId']).toBe(sub.id);
    expect(payload['documentType']).toBe('orders');
    expect(payload['dId']).toBe('order-1');
    expect(payload['document']).toEqual({ name: 'Test', amount: 100 });
    expect(payload['timestamp']).toBeDefined();
  });

  it('raw format returns document only', () => {
    const mgr = setup();
    const sub = mgr.subscribe({
      scope: 'document_type', documentType: 'orders', callbackUrl: 'url',
      options: { payloadFormat: 'raw', retrievalMode: 'full', schemaAdoptionMode: 'pinned', includeMetadata: false, deliveryMode: 'fire-and-forget' },
    });
    const payload = mgr.formatPayload({ name: 'Test', amount: 100 }, sub, dId, 'orders');
    expect(payload).toEqual({ name: 'Test', amount: 100 });
  });

  it('closed mode with Retrieval_Schema filters fields', () => {
    const mgr = setup();
    const sub = mgr.subscribe({
      scope: 'document_type', documentType: 'orders', callbackUrl: 'url',
      options: {
        retrievalMode: 'closed',
        retrievalSchema: { properties: { name: { type: 'string' } } },
        payloadFormat: 'raw', schemaAdoptionMode: 'pinned', includeMetadata: false, deliveryMode: 'fire-and-forget',
      },
    });
    const payload = mgr.formatPayload({ name: 'Test', amount: 100, extra: true }, sub, dId, 'orders');
    expect(payload).toEqual({ name: 'Test' });
  });
});

// ─── T12.7: Snapshot-at-Enqueue ─────────────────────────────────────────────

describe('T12.7: Snapshot-at-Enqueue', () => {
  it('creates webhook jobs for matching subscriptions', () => {
    const mgr = setup();
    mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url1' });
    mgr.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'url2' });

    const jobs = mgr.createWebhookJobs({ name: 'Test' }, 'orders', dId);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.payload).toBeDefined();
    expect(jobs[0]?.enqueuedAt).toBeDefined();
  });

  it('payload is snapshotted (not a live reference)', () => {
    const mgr = setup();
    mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url',
      options: { payloadFormat: 'raw', retrievalMode: 'full', schemaAdoptionMode: 'pinned', includeMetadata: false, deliveryMode: 'fire-and-forget' } });

    const doc = { name: 'Original' };
    const jobs = mgr.createWebhookJobs(doc, 'orders', dId);

    // Mutate original — snapshot should not change
    doc.name = 'Mutated';
    expect((jobs[0]?.payload as Record<string, unknown>)['name']).toBe('Original');
  });
});

// ─── T12.8: Auto-Cancel on Explicit Soft-Delete ─────────────────────────────

describe('T12.8: Auto-Cancel on Explicit Delete', () => {
  it('cancels all D-Id-level subscriptions for a document', () => {
    const mgr = setup();
    mgr.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'url1' });
    mgr.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'url2' });

    const cancelled = mgr.cancelAllForDocument('orders', dId);
    expect(cancelled).toBe(2);
    expect(mgr.listByDocumentId('orders', dId)).toHaveLength(0);
  });

  it('does not affect Document_Type-level subscriptions', () => {
    const mgr = setup();
    mgr.subscribe({ scope: 'document_type', documentType: 'orders', callbackUrl: 'url' });
    mgr.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'url2' });

    mgr.cancelAllForDocument('orders', dId);
    // Document_Type sub should still be active
    expect(mgr.listByDocumentType('orders')).toHaveLength(1);
  });

  it('returns 0 when no subscriptions to cancel', () => {
    const mgr = setup();
    expect(mgr.cancelAllForDocument('orders', dId)).toBe(0);
  });
});

// ─── T12.9: NO Auto-Cancel on TTL-Driven Delete ─────────────────────────────

describe('T12.9: No Cancel on TTL Delete', () => {
  it('TTL-driven delete does NOT call cancelAllForDocument (caller responsibility)', () => {
    // This is a behavioural contract: the Document Manager calls cancelAllForDocument
    // only for explicit deletes, not for TTL-driven. We verify the Subscription Manager
    // itself does not auto-cancel — it only cancels when explicitly asked.
    const mgr = setup();
    mgr.subscribe({ scope: 'document_id', documentType: 'orders', dId, callbackUrl: 'url' });

    // Subscriptions remain active (Document Manager would NOT call cancelAllForDocument for TTL)
    expect(mgr.findMatching('orders', dId)).toHaveLength(1);
  });
});

// ─── T12.10: Schema Adoption Mode ───────────────────────────────────────────

describe('T12.10: Schema Adoption', () => {
  it('pinned mode stores schema at creation', () => {
    const mgr = setup();
    const sub = mgr.subscribe({
      scope: 'document_type', documentType: 'orders', callbackUrl: 'url',
      options: {
        schemaAdoptionMode: 'pinned',
        retrievalSchema: { properties: { name: { type: 'string' } } },
        retrievalMode: 'closed', payloadFormat: 'envelope', includeMetadata: false, deliveryMode: 'fire-and-forget',
      },
    });
    expect(sub.options.schemaAdoptionMode).toBe('pinned');
    expect(sub.options.retrievalSchema).toBeDefined();
  });

  it('propagate mode is stored for future version adoption', () => {
    const mgr = setup();
    const sub = mgr.subscribe({
      scope: 'document_type', documentType: 'orders', callbackUrl: 'url',
      options: {
        schemaAdoptionMode: 'propagate',
        retrievalMode: 'full', payloadFormat: 'envelope', includeMetadata: false, deliveryMode: 'fire-and-forget',
      },
    });
    expect(sub.options.schemaAdoptionMode).toBe('propagate');
  });
});
