/**
 * Unit & integration tests for Component 8: Document Manager
 *
 * Covers T8.1 (store pipeline), T8.2 (merge semantics), T8.3 (upsert),
 * T8.4 (array handling), T8.5–T8.7 (soft delete), T8.8 (D-Id uniqueness),
 * T8.9 (Document_Type binding), T8.10 (quarantine hook).
 *
 * Also validates T17.17–T17.19 (enrichment integration wiring).
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/storage/memory-store.js';
import { SchemaManagerImpl } from '../src/schema/schema-manager.js';
import { DocumentTypeRegistryImpl } from '../src/document-type/document-type-registry.js';
import { EnrichmentEngineImpl } from '../src/enrichment/enrichment-engine.js';
import { DIdExtractorImpl } from '../src/did/did-extractor.js';
import { VersionManagerImpl } from '../src/version/version-manager.js';
import { DocumentManagerImpl } from '../src/document-manager/document-manager.js';
import type { ChannelResolution } from '../src/channel/types.js';

// ─── Test Setup ─────────────────────────────────────────────────────────────

function setup() {
  const storage = new MemoryStore();
  const schemaManager = new SchemaManagerImpl();
  const docTypeRegistry = new DocumentTypeRegistryImpl();
  const enrichmentEngine = new EnrichmentEngineImpl();
  const didExtractor = new DIdExtractorImpl();
  const versionManager = new VersionManagerImpl();

  // Register a schema with identityKind
  schemaManager.register({
    ref: 'order-v1',
    schema: {
      type: 'object',
      properties: {
        orderId: { type: 'integer', identityKind: 'primary-key' },
        name: { type: 'string' },
        amount: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['orderId', 'name'],
    },
  });

  // Register Document_Type
  docTypeRegistry.register({
    name: 'orders',
    masterSchema: 'order-v1',
    model: 'closed',
  });

  const docManager = new DocumentManagerImpl({
    storage,
    schemaManager,
    docTypeRegistry,
    enrichmentEngine,
    didExtractor,
    versionManager,
  });

  const resolution: ChannelResolution = {
    documentType: 'orders',
    applicableSchema: 'order-v1',
    source: 'url',
  };

  return { storage, schemaManager, docTypeRegistry, enrichmentEngine, docManager, resolution };
}

// ─── T8.1: Store Pipeline ───────────────────────────────────────────────────

describe('T8.1: Store Pipeline', () => {
  it('stores a new document through the full pipeline', () => {
    const { docManager, resolution } = setup();
    const result = docManager.store(
      { document: { orderId: 1, name: 'Order One', amount: 100 } },
      resolution,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.dId).toEqual({ type: 'single', value: '1' });
    expect(result.versionNo).toBe(1);
    expect(result.created).toBe(true);
  });

  it('rejects document failing schema validation', () => {
    const { docManager, resolution } = setup();
    const result = docManager.store(
      { document: { orderId: 1 } }, // missing required 'name'
      resolution,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('rejects document with extra fields under DCM', () => {
    const { docManager, resolution } = setup();
    const result = docManager.store(
      { document: { orderId: 1, name: 'Test', unknownField: 'nope' } },
      resolution,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('extracts D-Id from the document using identityKind', () => {
    const { docManager, resolution, storage } = setup();
    docManager.store(
      { document: { orderId: 42, name: 'Test' } },
      resolution,
    );

    const stored = storage.retrieve('orders', { type: 'single', value: '42' });
    expect(stored).toBeDefined();
    expect(stored?.dId).toEqual({ type: 'single', value: '42' });
  });
});

// ─── T8.2: Merge Semantics ──────────────────────────────────────────────────

describe('T8.2: Merge Semantics', () => {
  it('updates present leaves, preserves absent leaves', () => {
    const { docManager, resolution, storage } = setup();

    // Create
    docManager.store({ document: { orderId: 1, name: 'Original', amount: 100 } }, resolution);

    // Merge: update name, leave amount unchanged
    docManager.store({ document: { orderId: 1, name: 'Updated' } }, resolution);

    const stored = storage.retrieve('orders', { type: 'single', value: '1' });
    expect(stored).toBeDefined();

    // Name should be updated
    const nameLeaf = stored?.root.children.get('name') as { value: unknown } | undefined;
    expect(nameLeaf?.value).toBe('Updated');

    // Amount should be preserved
    const amountLeaf = stored?.root.children.get('amount') as { value: unknown } | undefined;
    expect(amountLeaf?.value).toBe(100);
  });

  it('preserves previous value in history on merge', () => {
    const { docManager, resolution, storage } = setup();

    docManager.store({ document: { orderId: 1, name: 'v1', amount: 50 } }, resolution);
    docManager.store({ document: { orderId: 1, name: 'v2' } }, resolution);

    const stored = storage.retrieve('orders', { type: 'single', value: '1' });
    const nameLeaf = stored?.root.children.get('name') as { value: unknown; history: { value: unknown }[] } | undefined;
    expect(nameLeaf?.value).toBe('v2');
    expect(nameLeaf?.history).toHaveLength(1);
    expect(nameLeaf?.history[0]?.value).toBe('v1');
  });

  it('never removes leaves via store operation', () => {
    const { docManager, resolution, storage } = setup();

    docManager.store({ document: { orderId: 1, name: 'Test', amount: 100 } }, resolution);
    // Send update without amount — it should still be there
    docManager.store({ document: { orderId: 1, name: 'Updated' } }, resolution);

    const stored = storage.retrieve('orders', { type: 'single', value: '1' });
    expect(stored?.root.children.has('amount')).toBe(true);
  });
});

// ─── T8.3: Upsert Logic ────────────────────────────────────────────────────

describe('T8.3: Upsert Logic', () => {
  it('creates when D-Id is new', () => {
    const { docManager, resolution } = setup();
    const result = docManager.store(
      { document: { orderId: 1, name: 'New' } },
      resolution,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(true);
  });

  it('merges when D-Id exists', () => {
    const { docManager, resolution } = setup();
    docManager.store({ document: { orderId: 1, name: 'First' } }, resolution);
    const result = docManager.store({ document: { orderId: 1, name: 'Second' } }, resolution);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(false);
    expect(result.versionNo).toBe(2);
  });
});

// ─── T8.4: Array Handling ───────────────────────────────────────────────────

describe('T8.4: Array Handling', () => {
  it('treats arrays as atomic leaves (full replacement)', () => {
    const { docManager, resolution, storage } = setup();

    docManager.store({ document: { orderId: 1, name: 'Test', tags: ['a', 'b'] } }, resolution);
    docManager.store({ document: { orderId: 1, name: 'Test', tags: ['c'] } }, resolution);

    const stored = storage.retrieve('orders', { type: 'single', value: '1' });
    const tagsLeaf = stored?.root.children.get('tags') as { value: unknown; history: { value: unknown }[] } | undefined;
    expect(tagsLeaf?.value).toEqual(['c']);
    expect(tagsLeaf?.history[0]?.value).toEqual(['a', 'b']);
  });
});

// ─── T8.5–T8.7: Soft Delete ────────────────────────────────────────────────

describe('T8.5–T8.7: Soft Delete', () => {
  it('explicit soft delete marks document', () => {
    const { docManager, resolution, storage } = setup();
    docManager.store({ document: { orderId: 1, name: 'Test' } }, resolution);

    const result = docManager.softDelete('orders', { type: 'single', value: '1' }, 'explicit');
    expect(result.success).toBe(true);

    const stored = storage.retrieve('orders', { type: 'single', value: '1' });
    expect(stored?.softDeleted).toBe(true);
    expect(stored?.softDeleteType).toBe('explicit');
    expect(stored?.softDeleteTimestamp).toBeDefined();
  });

  it('TTL-driven soft delete', () => {
    const { docManager, resolution, storage } = setup();
    docManager.store({ document: { orderId: 1, name: 'Test' } }, resolution);

    docManager.softDelete('orders', { type: 'single', value: '1' }, 'ttl_expired');
    const stored = storage.retrieve('orders', { type: 'single', value: '1' });
    expect(stored?.softDeleteType).toBe('ttl_expired');
  });

  it('system-override soft delete', () => {
    const { docManager, resolution, storage } = setup();
    docManager.store({ document: { orderId: 1, name: 'Test' } }, resolution);

    docManager.softDelete('orders', { type: 'single', value: '1' }, 'system_override');
    const stored = storage.retrieve('orders', { type: 'single', value: '1' });
    expect(stored?.softDeleteType).toBe('system_override');
  });

  it('rejects soft delete of non-existent document', () => {
    const { docManager } = setup();
    const result = docManager.softDelete('orders', { type: 'single', value: 'nope' }, 'explicit');
    expect(result.success).toBe(false);
  });

  it('rejects soft delete of already-deleted document', () => {
    const { docManager, resolution } = setup();
    docManager.store({ document: { orderId: 1, name: 'Test' } }, resolution);
    docManager.softDelete('orders', { type: 'single', value: '1' }, 'explicit');

    const result = docManager.softDelete('orders', { type: 'single', value: '1' }, 'explicit');
    expect(result.success).toBe(false);
    expect(result.code).toBe('ALREADY_DELETED');
  });
});

// ─── T8.8: D-Id Uniqueness & T8.9: Document_Type Binding ───────────────────

describe('T8.8 & T8.9: Identity & Type Binding', () => {
  it('same D-Id in same Document_Type = same document (upsert)', () => {
    const { docManager, resolution } = setup();
    docManager.store({ document: { orderId: 1, name: 'First' } }, resolution);
    const result = docManager.store({ document: { orderId: 1, name: 'Second' } }, resolution);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(false); // Same document, merged
  });

  it('hasDocumentsOfType returns true when documents exist', () => {
    const { docManager, resolution } = setup();
    docManager.store({ document: { orderId: 1, name: 'Test' } }, resolution);
    expect(docManager.hasDocumentsOfType('orders')).toBe(true);
  });

  it('hasDocumentsOfType returns false when no documents', () => {
    const { docManager } = setup();
    expect(docManager.hasDocumentsOfType('orders')).toBe(false);
  });
});

// ─── T8.10: Quarantine Hook ─────────────────────────────────────────────────

describe('T8.10: Quarantine Hook', () => {
  it('calls onPayloadRejected hook on validation failure', () => {
    const { docManager, resolution } = setup();
    const rejected: unknown[] = [];
    docManager.setHooks({
      onPayloadRejected: (payload, reason) => { rejected.push({ payload, reason }); },
    });

    docManager.store({ document: { orderId: 1 } }, resolution); // missing 'name'
    expect(rejected).toHaveLength(1);
  });

  it('calls onDocumentStored hook on success', () => {
    const { docManager, resolution } = setup();
    const stored: unknown[] = [];
    docManager.setHooks({
      onDocumentStored: (docType, dId) => { stored.push({ docType, dId }); },
    });

    docManager.store({ document: { orderId: 1, name: 'Test' } }, resolution);
    expect(stored).toHaveLength(1);
  });
});

// ─── T17.17–T17.19: Enrichment Integration ─────────────────────────────────

describe('T17.17–T17.19: Enrichment Integration', () => {
  it('enrichment is applied before validation (T17.17, T17.18)', () => {
    const { docManager, enrichmentEngine, resolution } = setup();

    // Register bindings that supply the required 'name' field
    enrichmentEngine.registerBindings('__document_type_level__', [
      { fieldPath: 'name', staticValue: 'Enriched Name' },
    ]);

    // Payload omits 'name' but enrichment supplies it → should pass validation
    const result = docManager.store(
      { document: { orderId: 1, amount: 50 } },
      resolution,
    );
    expect(result.success).toBe(true);
  });

  it('D-Id extraction operates on Enriched_Document (T17.19)', () => {
    const { docManager, enrichmentEngine, schemaManager, docTypeRegistry, storage } = setup();

    // Set up a schema where deviceId is the primary key
    schemaManager.register({
      ref: 'device-v1',
      schema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', identityKind: 'primary-key' },
          temperature: { type: 'number' },
        },
        required: ['deviceId', 'temperature'],
      },
    });
    docTypeRegistry.register({ name: 'devices', masterSchema: 'device-v1', model: 'closed' });

    // Enrichment supplies the identity field
    enrichmentEngine.registerBindings('device-channel', [
      { fieldPath: 'deviceId', staticValue: 'SENSOR-42' },
    ]);

    const deviceResolution: ChannelResolution = {
      documentType: 'devices',
      channelId: 'device-channel',
      applicableSchema: 'device-v1',
      source: 'url',
    };

    const result = docManager.store(
      { document: { temperature: 25 } },
      deviceResolution,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.dId).toEqual({ type: 'single', value: 'SENSOR-42' });

    // Verify it's stored with the enriched deviceId
    const stored = storage.retrieve('devices', { type: 'single', value: 'SENSOR-42' });
    expect(stored).toBeDefined();
  });

  it('enrichment conflict with accept-and-warn produces warning', () => {
    const { docManager, enrichmentEngine, resolution } = setup();

    enrichmentEngine.registerBindings('__document_type_level__', [
      { fieldPath: 'name', staticValue: 'Enriched' },
    ]);

    const result = docManager.store(
      { document: { orderId: 1, name: 'Payload Value' } },
      resolution,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warning?.code).toBe('ENRICHMENT_CONFLICT');
  });

  it('enrichment conflict with discard-and-error rejects', () => {
    const { docManager, enrichmentEngine, resolution } = setup();

    enrichmentEngine.setPolicies({ conflictResolution: 'discard-and-error' });
    enrichmentEngine.registerBindings('__document_type_level__', [
      { fieldPath: 'name', staticValue: 'Enriched' },
    ]);

    const result = docManager.store(
      { document: { orderId: 1, name: 'Payload Value' } },
      resolution,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('ENRICHMENT_CONFLICT');
  });
});

// ─── Optimistic Concurrency (T7.9/T7.10 via C8) ────────────────────────────

describe('Optimistic Concurrency via Store', () => {
  it('blind write succeeds (no versionNo provided)', () => {
    const { docManager, resolution } = setup();
    docManager.store({ document: { orderId: 1, name: 'v1' } }, resolution);
    const result = docManager.store({ document: { orderId: 1, name: 'v2' } }, resolution);
    expect(result.success).toBe(true);
  });

  it('matching versionNo succeeds', () => {
    const { docManager, resolution } = setup();
    docManager.store({ document: { orderId: 1, name: 'v1' } }, resolution);
    const result = docManager.store(
      { document: { orderId: 1, name: 'v2' }, versionNo: 1 },
      resolution,
    );
    expect(result.success).toBe(true);
  });

  it('stale versionNo rejected', () => {
    const { docManager, resolution } = setup();
    docManager.store({ document: { orderId: 1, name: 'v1' } }, resolution);
    docManager.store({ document: { orderId: 1, name: 'v2' } }, resolution);

    const result = docManager.store(
      { document: { orderId: 1, name: 'v3' }, versionNo: 1 },
      resolution,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('VERSION_CONFLICT');
  });
});

// ─── 0.4.1: commitTime finalisation on stored timestampList entries ─────────
//
// Defect (pre-0.4.1): every stored timestampList entry carried commitTime: ''
// because the store pipeline discarded finaliseTimestamp's result. The fix
// finalises the just-appended entry in place on both the create and merge paths
// (Option B — before the single storage.store). requestTime is preserved; only
// commitTime is filled. See docs/working-notes/defect-commit-timestamp-never-finalised.md.

describe('0.4.1: commitTime finalisation (Req 39.3 Commit_Timestamp)', () => {
  const dId = { type: 'single' as const, value: '1' };

  it('fills commitTime on create (non-empty, >= requestTime, requestTime preserved)', () => {
    const { docManager, storage, resolution } = setup();
    docManager.store({ document: { orderId: 1, name: 'v1' } }, resolution);

    const doc = storage.retrieve('orders', dId)!;
    expect(doc.timestampList).toHaveLength(1);
    const ts = doc.timestampList[0]!;
    expect(ts.commitTime).not.toBe('');
    expect(ts.requestTime).not.toBe('');
    // Both are ISO strings; commit completes at or after request receipt.
    expect(new Date(ts.commitTime).getTime()).toBeGreaterThanOrEqual(new Date(ts.requestTime).getTime());
    // creationTime still tracks the first entry's requestTime (unaffected by finalisation).
    expect(doc.creationTime).toBe(ts.requestTime);
  });

  it('fills commitTime on merge, and leaves earlier entries finalised and untouched', () => {
    const { docManager, storage, resolution } = setup();
    docManager.store({ document: { orderId: 1, name: 'v1' } }, resolution);
    const afterCreate = storage.retrieve('orders', dId)!;
    const firstEntrySnapshot = { ...afterCreate.timestampList[0]! };

    docManager.store({ document: { orderId: 1, name: 'v2' } }, resolution);
    const doc = storage.retrieve('orders', dId)!;

    expect(doc.timestampList).toHaveLength(2);
    // The newly appended (second) entry is finalised.
    const newest = doc.timestampList[1]!;
    expect(newest.commitTime).not.toBe('');
    expect(new Date(newest.commitTime).getTime()).toBeGreaterThanOrEqual(new Date(newest.requestTime).getTime());
    // The earlier entry is unchanged — still finalised, requestTime intact
    // (finalising entry N does not disturb entries < N).
    expect(doc.timestampList[0]).toEqual(firstEntrySnapshot);
  });

  it('every entry is finalised across a multi-store sequence', () => {
    const { docManager, storage, resolution } = setup();
    for (let i = 1; i <= 5; i++) {
      docManager.store({ document: { orderId: 1, name: `v${i}` } }, resolution);
    }
    const doc = storage.retrieve('orders', dId)!;
    expect(doc.timestampList).toHaveLength(5);
    for (const ts of doc.timestampList) {
      expect(ts.commitTime).not.toBe('');
      expect(new Date(ts.commitTime).getTime()).toBeGreaterThanOrEqual(new Date(ts.requestTime).getTime());
    }
  });
});
