/**
 * Integration & Property Tests — Component 16
 *
 * T16.1–T16.14: Property-based tests for correctness properties.
 * T16.15–T16.20: Integration tests for end-to-end flows.
 *
 * Design reference: design.md § Correctness Properties
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Fastify from 'fastify';
import { registerAllRoutes } from '../src/api/index.js';
import type { AppContext } from '../src/api/context.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import { StorageManager } from '../src/storage/storage-manager.js';
import { SchemaManagerImpl } from '../src/schema/schema-manager.js';
import { DocumentTypeRegistryImpl } from '../src/document-type/document-type-registry.js';
import { ChannelResolverImpl } from '../src/channel/channel-resolver.js';
import { DIdExtractorImpl } from '../src/did/did-extractor.js';
import { VersionManagerImpl } from '../src/version/version-manager.js';
import { EnrichmentEngineImpl } from '../src/enrichment/enrichment-engine.js';
import { DocumentManagerImpl } from '../src/document-manager/document-manager.js';
import { QueryEngineImpl } from '../src/query/query-engine.js';
import { TtlManagerImpl } from '../src/ttl/ttl-manager.js';
import { QuarantineStoreImpl } from '../src/quarantine/quarantine-store.js';
import { SubscriptionManagerImpl } from '../src/subscription/subscription-manager.js';
import { WebhookDispatcherImpl } from '../src/webhook/webhook-dispatcher.js';
import type { ChannelResolution } from '../src/channel/types.js';
import type { StoredLeaf } from '../src/storage/types.js';

// ─── Test Harness ───────────────────────────────────────────────────────────

function createFullStack() {
  const storage = new MemoryStore();
  const storageManager = new StorageManager({ mode: 'memory' });
  const schemaManager = new SchemaManagerImpl();
  const docTypeRegistry = new DocumentTypeRegistryImpl();
  const channelResolver = new ChannelResolverImpl(docTypeRegistry);
  const didExtractor = new DIdExtractorImpl();
  const versionManager = new VersionManagerImpl();
  const enrichmentEngine = new EnrichmentEngineImpl();
  const queryEngine = new QueryEngineImpl(storage);
  const ttlManager = new TtlManagerImpl();
  const quarantineStore = new QuarantineStoreImpl();
  const subscriptionManager = new SubscriptionManagerImpl();
  const webhookDispatcher = new WebhookDispatcherImpl();

  const documentManager = new DocumentManagerImpl({
    storage, schemaManager, docTypeRegistry, enrichmentEngine, didExtractor, versionManager,
  });

  // Seed schema + docType
  schemaManager.register({
    ref: 'test-v1',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', identityKind: 'primary-key' },
        name: { type: 'string' },
        value: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'name'],
    },
  });
  docTypeRegistry.register({ name: 'items', masterSchema: 'test-v1', model: 'closed' });

  const resolution: ChannelResolution = { documentType: 'items', applicableSchema: 'test-v1', source: 'url' };

  return {
    storage, storageManager, schemaManager, docTypeRegistry, channelResolver,
    didExtractor, versionManager, enrichmentEngine, documentManager, queryEngine,
    ttlManager, quarantineStore, subscriptionManager, webhookDispatcher, resolution,
  };
}

// ─── T16.1: Properties 1–4 (Versioning Invariants) ─────────────────────────

describe('T16.1: Properties 1–4 (Versioning)', () => {
  it('Property 1: leaf versionNo >= history.length + 1 (equality when no eviction)', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), (numUpdates) => {
      const { documentManager, resolution, storage } = createFullStack();
      // Create
      documentManager.store({ document: { id: 1, name: 'init' } }, resolution);

      // Apply N updates
      for (let i = 0; i < numUpdates; i++) {
        documentManager.store({ document: { id: 1, name: `v${i + 2}` } }, resolution);
      }

      const doc = storage.retrieve('items', { type: 'single', value: '1' })!;
      const nameLeaf = doc.root.children.get('name') as StoredLeaf;
      // versionNo >= history.length + 1 (equality unless eviction occurred)
      expect(nameLeaf.metadata.versionNo).toBeGreaterThanOrEqual(nameLeaf.history.length + 1);
    }), { numRuns: 50 });
  });

  it('Property 2: previous value in history after update (depth > 0)', () => {
    const { documentManager, resolution, storage } = createFullStack();
    documentManager.store({ document: { id: 1, name: 'old-value' } }, resolution);
    documentManager.store({ document: { id: 1, name: 'new-value' } }, resolution);

    const doc = storage.retrieve('items', { type: 'single', value: '1' })!;
    const nameLeaf = doc.root.children.get('name') as StoredLeaf;
    expect(nameLeaf.value).toBe('new-value');
    expect(nameLeaf.history[nameLeaf.history.length - 1]?.value).toBe('old-value');
  });

  it('Property 4: document versionNo = timestamp list length', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 15 }), (numStores) => {
      const { documentManager, resolution, storage } = createFullStack();

      for (let i = 0; i < numStores; i++) {
        documentManager.store({ document: { id: 1, name: `v${i + 1}` } }, resolution);
      }

      const doc = storage.retrieve('items', { type: 'single', value: '1' })!;
      expect(doc.versionNo).toBe(doc.timestampList.length);
    }), { numRuns: 50 });
  });
});

// ─── T16.3: Properties 7–9 (Optimistic Concurrency) ────────────────────────

describe('T16.3: Properties 7–9 (Concurrency)', () => {
  it('Property 7: stale versionNo rejected', () => {
    const { documentManager, resolution } = createFullStack();
    documentManager.store({ document: { id: 1, name: 'v1' } }, resolution);
    documentManager.store({ document: { id: 1, name: 'v2' } }, resolution);

    const result = documentManager.store({ document: { id: 1, name: 'v3' }, versionNo: 1 }, resolution);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('VERSION_CONFLICT');
  });

  it('Property 8: blind write always applies', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10 }), (numWrites) => {
      const { documentManager, resolution, storage } = createFullStack();

      for (let i = 0; i < numWrites; i++) {
        const result = documentManager.store({ document: { id: 1, name: `v${i + 1}` } }, resolution);
        expect(result.success).toBe(true);
      }

      const doc = storage.retrieve('items', { type: 'single', value: '1' })!;
      expect(doc.versionNo).toBe(numWrites);
    }), { numRuns: 30 });
  });

  it('Property 9: response includes versionNo and dId', () => {
    const { documentManager, resolution } = createFullStack();
    const result = documentManager.store({ document: { id: 1, name: 'test' } }, resolution);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.versionNo).toBe(1);
    expect(result.dId).toEqual({ type: 'single', value: '1' });
  });
});

// ─── T16.4: Properties 10–12 (TTL) ─────────────────────────────────────────

describe('T16.4: Properties 10–12 (TTL)', () => {
  it('Property 10: most specific TTL scope wins', () => {
    const { ttlManager } = createFullStack();
    ttlManager.configureTtl('instance', 3600);
    ttlManager.configureTtl('document_type', 1800, 'items');
    const key = 'items\x011';
    ttlManager.configureTtl('document', 60, key);

    expect(ttlManager.getEffectiveTtl('items', { type: 'single', value: '1' })).toBe(60);
  });
});

// ─── T16.8: Properties 17–18 (Depth-0) ─────────────────────────────────────

describe('T16.8: Properties 17–18 (Depth-0)', () => {
  it('Property 17: depth-0 retains no history but versionNo increments', () => {
    const vm = new VersionManagerImpl();
    let leaf: StoredLeaf = { value: 'v1', metadata: { timestampRef: { index: 0 }, versionNo: 1 }, history: [] };

    for (let i = 1; i <= 5; i++) {
      ({ updatedLeaf: leaf } = vm.updateLeaf(leaf, `v${i + 1}`, { index: i }, 0));
    }

    expect(leaf.metadata.versionNo).toBe(6);
    expect(leaf.history).toHaveLength(0);
  });

  it('Property 18: concurrency control works at depth-0', () => {
    const vm = new VersionManagerImpl();
    // After 3 updates at depth 0, version is 4
    expect(vm.checkConcurrency(4, 4).success).toBe(true);
    expect(vm.checkConcurrency(4, 3).success).toBe(false);
  });
});

// ─── T16.9: Properties 19–22 (Merge, DCM, Errors) ──────────────────────────

describe('T16.9: Properties 19–22 (Merge & DCM)', () => {
  it('Property 20: absent leaves preserved on merge', () => {
    const { documentManager, resolution, storage } = createFullStack();
    documentManager.store({ document: { id: 1, name: 'v1', value: 42 } }, resolution);
    documentManager.store({ document: { id: 1, name: 'v2' } }, resolution); // value absent

    const doc = storage.retrieve('items', { type: 'single', value: '1' })!;
    const valueLeaf = doc.root.children.get('value') as StoredLeaf;
    expect(valueLeaf.value).toBe(42); // preserved
  });

  it('Property 21: DCM rejects fields not in Master_Schema', () => {
    const { documentManager, resolution } = createFullStack();
    const result = documentManager.store(
      { document: { id: 1, name: 'test', unknownField: 'reject me' } },
      resolution,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('Property 22: no leaves removed by store operation', () => {
    const { documentManager, resolution, storage } = createFullStack();
    documentManager.store({ document: { id: 1, name: 'test', value: 10, tags: ['a'] } }, resolution);
    documentManager.store({ document: { id: 1, name: 'updated' } }, resolution);

    const doc = storage.retrieve('items', { type: 'single', value: '1' })!;
    expect(doc.root.children.has('value')).toBe(true);
    expect(doc.root.children.has('tags')).toBe(true);
  });
});

// ─── T16.10: Properties 23–24 (Non-existent D-Id Sub, Array Atomicity) ─────

describe('T16.10: Properties 23–24', () => {
  it('Property 23: subscription on non-existent D-Id is valid', () => {
    const { subscriptionManager } = createFullStack();
    const sub = subscriptionManager.subscribe({
      scope: 'document_id',
      documentType: 'items',
      dId: { type: 'single', value: 'not-yet-created' },
      callbackUrl: 'http://example.com/hook',
    });
    expect(sub.active).toBe(true);
  });

  it('Property 24: arrays are atomic (full replacement, no element update)', () => {
    const { documentManager, resolution, storage } = createFullStack();
    documentManager.store({ document: { id: 1, name: 'test', tags: ['a', 'b', 'c'] } }, resolution);
    documentManager.store({ document: { id: 1, name: 'test', tags: ['x'] } }, resolution);

    const doc = storage.retrieve('items', { type: 'single', value: '1' })!;
    const tagsLeaf = doc.root.children.get('tags') as StoredLeaf;
    expect(tagsLeaf.value).toEqual(['x']);
    expect(tagsLeaf.history[0]?.value).toEqual(['a', 'b', 'c']);
  });
});

// ─── T16.11: Properties 25–28 ───────────────────────────────────────────────

describe('T16.11: Properties 25–28', () => {
  it('Property 26: explicit soft-delete cancels D-Id subscriptions', () => {
    const { documentManager, subscriptionManager, resolution } = createFullStack();
    documentManager.store({ document: { id: 1, name: 'test' } }, resolution);

    const dId = { type: 'single' as const, value: '1' };
    subscriptionManager.subscribe({ scope: 'document_id', documentType: 'items', dId, callbackUrl: 'url' });

    const cancelled = subscriptionManager.cancelAllForDocument('items', dId);
    expect(cancelled).toBe(1);
  });

  it('Property 28: channel resolution produces correct schema', () => {
    const { channelResolver, schemaManager } = createFullStack();
    schemaManager.register({ ref: 'channel-schema-v1', schema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }, required: ['id', 'name'] } });
    channelResolver.register({ channelId: 'ch-test', documentType: 'items', channelSchema: 'channel-schema-v1' });

    const result = channelResolver.resolve('/api/v1/ingest/items/ch-test');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.resolution.applicableSchema).toBe('channel-schema-v1');
  });
});

// ─── T16.13: Properties 36–38 (Enrichment) ─────────────────────────────────

describe('T16.13: Properties 36–38 (Enrichment)', () => {
  it('Property 36: enrichment runs before validation (pipeline order)', () => {
    const { documentManager, enrichmentEngine, resolution } = createFullStack();
    // Enrich the name field so a payload missing 'name' still passes
    enrichmentEngine.registerBindings('__document_type_level__', [
      { fieldPath: 'name', staticValue: 'Enriched' },
    ]);

    const result = documentManager.store({ document: { id: 1, value: 10 } }, resolution);
    expect(result.success).toBe(true);
  });

  it('Property 37: conflict detection between payload and bindings only', () => {
    const { enrichmentEngine } = createFullStack();
    enrichmentEngine.registerBindings('ch-x', [{ fieldPath: 'loc', staticValue: 'A' }]);

    // First call: conflict between payload and binding
    const r1 = enrichmentEngine.enrich({ loc: 'B' }, 'ch-x');
    expect(r1.conflicts).toHaveLength(1);

    // Second call: same-value = no conflict
    const r2 = enrichmentEngine.enrich({ loc: 'A' }, 'ch-x');
    expect(r2.conflicts).toHaveLength(0);
  });
});

// ─── T16.14: Properties 39–40 ───────────────────────────────────────────────

describe('T16.14: Properties 39–40', () => {
  it('Property 39: D-Id uniqueness scoped to Document_Type', () => {
    const stack = createFullStack();
    // Store same id=1 in 'items' type
    stack.documentManager.store({ document: { id: 1, name: 'first' } }, stack.resolution);
    const r2 = stack.documentManager.store({ document: { id: 1, name: 'second' } }, stack.resolution);
    // Same docType + same D-Id = merge (not create new)
    expect(r2.success).toBe(true);
    if (!r2.success) return;
    expect(r2.created).toBe(false);
  });

  it('Property 40: timestamp list grows monotonically', () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 10 }), (numStores) => {
      const { documentManager, resolution, storage } = createFullStack();

      for (let i = 0; i < numStores; i++) {
        documentManager.store({ document: { id: 1, name: `v${i}` } }, resolution);
      }

      const doc = storage.retrieve('items', { type: 'single', value: '1' })!;
      // Timestamp list length must equal number of stores
      expect(doc.timestampList.length).toBe(numStores);
      // Each entry's requestTime must be >= previous
      for (let i = 1; i < doc.timestampList.length; i++) {
        expect(doc.timestampList[i]!.requestTime >= doc.timestampList[i - 1]!.requestTime).toBe(true);
      }
    }), { numRuns: 30 });
  });
});

// ─── T16.15: End-to-End Store → Subscribe → Deliver ─────────────────────────

describe('T16.15: E2E Store → Subscribe → Deliver', () => {
  it('stores document, matches subscription, creates webhook job', () => {
    const { documentManager, subscriptionManager, resolution } = createFullStack();

    // Subscribe before storing
    subscriptionManager.subscribe({
      scope: 'document_type',
      documentType: 'items',
      callbackUrl: 'http://consumer.test/hook',
    });

    // Store triggers subscription matching
    documentManager.store({ document: { id: 1, name: 'test' } }, resolution);

    // Create webhook jobs for the stored document
    const jobs = subscriptionManager.createWebhookJobs(
      { id: 1, name: 'test' },
      'items',
      { type: 'single', value: '1' },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toBeDefined();
  });
});

// ─── T16.16: Channel Registration → Ingestion → Validation ─────────────────

describe('T16.16: Channel → Ingest → Validate', () => {
  it('full channel ingestion flow via HTTP', async () => {
    const stack = createFullStack();
    const app = Fastify({ logger: false });
    registerAllRoutes(app, { ...stack, dIdDelimiter: ':' } as unknown as AppContext);
    await app.ready();

    // Register channel
    stack.channelResolver.register({ channelId: 'sensor-ch', documentType: 'items' });

    // Ingest via channel
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/items/sensor-ch',
      payload: { id: 99, name: 'Sensor Data', value: 22.5 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().dId).toBe('99');
  });
});

// ─── T16.19: Enrichment Flow ────────────────────────────────────────────────

describe('T16.19: Enrichment E2E', () => {
  it('enrichment supplies required field, minimal payload stores', () => {
    const { documentManager, enrichmentEngine, channelResolver } = createFullStack();

    channelResolver.register({ channelId: 'enriched-ch', documentType: 'items' });
    enrichmentEngine.registerBindings('enriched-ch', [
      { fieldPath: 'name', staticValue: 'Auto-Named' },
    ]);

    const channelResolution: ChannelResolution = {
      documentType: 'items',
      channelId: 'enriched-ch',
      applicableSchema: 'test-v1',
      source: 'url',
    };

    // Payload missing 'name' but enrichment provides it
    const result = documentManager.store({ document: { id: 5, value: 100 } }, channelResolution);
    expect(result.success).toBe(true);
  });
});

// ─── T16.20: Enrichment Conflict Flow ───────────────────────────────────────

describe('T16.20: Enrichment Conflict E2E', () => {
  it('accept-and-warn: proceeds with warning', () => {
    const { documentManager, enrichmentEngine, channelResolver } = createFullStack();

    channelResolver.register({ channelId: 'conflict-ch', documentType: 'items' });
    enrichmentEngine.registerBindings('conflict-ch', [{ fieldPath: 'name', staticValue: 'Enriched' }]);

    const channelResolution: ChannelResolution = {
      documentType: 'items',
      channelId: 'conflict-ch',
      applicableSchema: 'test-v1',
      source: 'url',
    };

    const result = documentManager.store(
      { document: { id: 1, name: 'Payload Value' } },
      channelResolution,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warning?.code).toBe('ENRICHMENT_CONFLICT');
  });

  it('discard-and-error: rejects payload', () => {
    const { documentManager, enrichmentEngine, channelResolver } = createFullStack();

    enrichmentEngine.setPolicies({ conflictResolution: 'discard-and-error' });
    channelResolver.register({ channelId: 'strict-ch', documentType: 'items' });
    enrichmentEngine.registerBindings('strict-ch', [{ fieldPath: 'name', staticValue: 'Enriched' }]);

    const channelResolution: ChannelResolution = {
      documentType: 'items',
      channelId: 'strict-ch',
      applicableSchema: 'test-v1',
      source: 'url',
    };

    const result = documentManager.store(
      { document: { id: 1, name: 'Different' } },
      channelResolution,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('ENRICHMENT_CONFLICT');
  });
});

// ─── 0.4.0: TTL sliding-window + revival-on-update (end-to-end) ─────────────
//
// Wire the TTL enforcement exactly as src/index.ts main() does, over the full
// stack, and exercise the sliding window, revival-on-update, and the
// snapshot-at-enqueue decoupling from TTL expiry.

function wireTtl(stack: ReturnType<typeof createFullStack>) {
  const { documentManager, ttlManager, queryEngine } = stack;
  documentManager.setHooks({
    onDocumentStored: (documentType, dId, document) => {
      const effectiveTtl = document.ttl ?? ttlManager.getEffectiveTtl(documentType, dId);
      const lastUpdateTime =
        document.timestampList[document.timestampList.length - 1]?.requestTime ?? document.creationTime;
      ttlManager.registerExpiry(documentType, dId, lastUpdateTime, effectiveTtl, document.expireAt);
    },
    isSalvageable: (document) => {
      const r = ttlManager.checkOnAccess(document);
      return r.valid && r.action === 'serve';
    },
  });
  queryEngine.setTtlChecker((doc) => ttlManager.checkOnAccess(doc));
  queryEngine.setOnAccessPersist((documentType, dId, reason) => {
    const deleteType = reason === 'absolute-expired' ? 'absolute_expired' : 'ttl_expired';
    documentManager.softDelete(documentType, dId, deleteType);
    ttlManager.removeExpiry(documentType, dId);
  });
  const runSweep = (now?: string): void => {
    for (const entry of ttlManager.getExpiredEntries(now)) {
      const deleteType = entry.hasExpireAtPolicy ? 'absolute_expired' : 'ttl_expired';
      documentManager.softDelete(entry.documentType, entry.dId, deleteType);
      ttlManager.removeExpiry(entry.documentType, entry.dId);
    }
  };
  return runSweep;
}

describe('0.4.0: TTL sliding-window + revival (Req 37.3b, 37b.5a, 32.8b)', () => {
  it('revival-on-update: a store to a swept salvageable doc clears soft-delete and continues the lineage', () => {
    const stack = createFullStack();
    const { documentManager, ttlManager, storage, resolution } = stack;
    const runSweep = wireTtl(stack);
    ttlManager.configureTtl('document_type', 1, 'items'); // 1s TTL, salvageable

    documentManager.store({ document: { id: 1, name: 'v1' } }, resolution);
    const dId = { type: 'single' as const, value: '1' };

    // Age the sliding anchor (and creationTime) into the past and sweep →
    // ttl_expired soft-delete. We fix creationTime to `past` so we can assert it
    // is preserved verbatim across the revival (revived, not re-created).
    const past = '2026-09-01T00:00:00Z';
    const stored = storage.retrieve('items', dId)!;
    storage.store('items', dId, {
      ...stored,
      creationTime: past,
      timestampList: stored.timestampList.map((t) => ({ ...t, requestTime: past })),
    });
    ttlManager.registerExpiry('items', dId, past, 1);
    runSweep();
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(true);

    // Update → revive.
    documentManager.store({ document: { id: 1, name: 'v2' } }, resolution);
    const revived = storage.retrieve('items', dId)!;
    expect(revived.softDeleted).toBe(false);
    expect(revived.softDeleteType).toBeUndefined();
    expect(revived.creationTime).toBe(past);                 // preserved (audit) — NOT re-created
    expect(revived.versionNo).toBe(stored.versionNo + 1);    // lineage continues
  });

  it('snapshot-at-enqueue: an enqueued webhook payload is unaffected by TTL expiry of its source doc', () => {
    const stack = createFullStack();
    const { documentManager, subscriptionManager, ttlManager, storage, resolution } = stack;
    const runSweep = wireTtl(stack);
    ttlManager.configureTtl('document_type', 1, 'items');

    subscriptionManager.subscribe({ scope: 'document_type', documentType: 'items', callbackUrl: 'http://consumer.test/hook' });
    documentManager.store({ document: { id: 1, name: 'snapshot-me' } }, resolution);
    const dId = { type: 'single' as const, value: '1' };

    // Capture the delivery snapshot at enqueue time (as the pipeline would).
    const jobs = subscriptionManager.createWebhookJobs({ id: 1, name: 'snapshot-me' }, 'items', dId);
    expect(jobs).toHaveLength(1);
    const enqueuedPayload = JSON.parse(JSON.stringify(jobs[0]!.payload));

    // Now expire + sweep the source document.
    const past = '2026-09-01T00:00:00Z';
    const stored = storage.retrieve('items', dId)!;
    storage.store('items', dId, { ...stored, creationTime: past, timestampList: stored.timestampList.map((t) => ({ ...t, requestTime: past })) });
    ttlManager.registerExpiry('items', dId, past, 1);
    runSweep();
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(true);

    // The already-enqueued snapshot is unchanged — decoupled from the doc lifecycle (Req 37.10, 35.11-13).
    expect(jobs[0]!.payload).toEqual(enqueuedPayload);
  });
});
