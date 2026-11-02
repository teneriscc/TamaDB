/**
 * Unit tests for Component 2: Storage Adapter
 *
 * Covers T2.1 (interface contract), T2.2 (MEMORY), T2.3 (DISK),
 * T2.4 (HYBRID), T2.5 (AUTO), T2.6 (runtime switching), T2.7 (mode exposure).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { MemoryStore } from '../src/storage/memory-store.js';
import { DiskStore } from '../src/storage/disk-store.js';
import { HybridStore } from '../src/storage/hybrid-store.js';
import { StorageManager } from '../src/storage/storage-manager.js';
import type { DocumentIdentifier, InternalDocument, StoredBunch } from '../src/storage/types.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const TEST_DISK_DIR = '.tamadb-test-data';

function makeDId(value: string): DocumentIdentifier {
  return { type: 'single', value };
}

function makeComposedDId(parts: string[]): DocumentIdentifier {
  return { type: 'composed', parts };
}

function makeDocument(
  documentType: string,
  dId: DocumentIdentifier,
  overrides: Partial<InternalDocument> = {},
): InternalDocument {
  const root: StoredBunch = {
    metadata: { timestampRef: { index: 0 }, versionNo: 1, history: [] },
    children: new Map([
      ['name', { value: 'test', metadata: { timestampRef: { index: 0 }, versionNo: 1 }, history: [] }],
    ]),
  };

  return {
    dId,
    documentType,
    timestampList: [{ requestTime: '2026-01-01T00:00:00Z', commitTime: '2026-01-01T00:00:01Z', channelIdentifier: 'default' }],
    versionNo: 1,
    historyDepth: 5,
    model: 'closed',
    root,
    softDeleted: false,
    ...overrides,
  };
}

function cleanupDisk(): void {
  if (existsSync(TEST_DISK_DIR)) {
    rmSync(TEST_DISK_DIR, { recursive: true, force: true });
  }
}

// ─── T2.1 & T2.2: StorageAdapter Interface + MEMORY strategy ────────────────

describe('T2.2: MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it('stores and retrieves a document', () => {
    const doc = makeDocument('orders', makeDId('order-1'));
    store.store('orders', makeDId('order-1'), doc);

    const retrieved = store.retrieve('orders', makeDId('order-1'));
    expect(retrieved).toEqual(doc);
  });

  it('returns undefined for non-existent document', () => {
    expect(store.retrieve('orders', makeDId('nope'))).toBeUndefined();
  });

  it('overwrites existing document on re-store', () => {
    const dId = makeDId('order-1');
    const doc1 = makeDocument('orders', dId);
    const doc2 = makeDocument('orders', dId, { versionNo: 2 });

    store.store('orders', dId, doc1);
    store.store('orders', dId, doc2);

    const retrieved = store.retrieve('orders', dId);
    expect(retrieved?.versionNo).toBe(2);
  });

  it('deletes a document', () => {
    const dId = makeDId('order-1');
    store.store('orders', dId, makeDocument('orders', dId));

    expect(store.delete('orders', dId)).toBe(true);
    expect(store.retrieve('orders', dId)).toBeUndefined();
  });

  it('returns false when deleting non-existent document', () => {
    expect(store.delete('orders', makeDId('nope'))).toBe(false);
  });

  it('has() returns true for existing documents', () => {
    const dId = makeDId('order-1');
    store.store('orders', dId, makeDocument('orders', dId));
    expect(store.has('orders', dId)).toBe(true);
  });

  it('has() returns false for non-existent documents', () => {
    expect(store.has('orders', makeDId('nope'))).toBe(false);
  });

  it('lists documents by document type', () => {
    store.store('orders', makeDId('o1'), makeDocument('orders', makeDId('o1')));
    store.store('orders', makeDId('o2'), makeDocument('orders', makeDId('o2')));
    store.store('customers', makeDId('c1'), makeDocument('customers', makeDId('c1')));

    const orderIds = store.listByDocumentType('orders');
    expect(orderIds).toHaveLength(2);

    const customerIds = store.listByDocumentType('customers');
    expect(customerIds).toHaveLength(1);
  });

  it('count() returns total document count', () => {
    store.store('orders', makeDId('o1'), makeDocument('orders', makeDId('o1')));
    store.store('orders', makeDId('o2'), makeDocument('orders', makeDId('o2')));
    expect(store.count()).toBe(2);
  });

  it('clear() removes all documents', () => {
    store.store('orders', makeDId('o1'), makeDocument('orders', makeDId('o1')));
    store.clear();
    expect(store.count()).toBe(0);
  });

  it('handles composed D-Ids correctly', () => {
    const dId = makeComposedDId(['customer-A', 'order-1']);
    const doc = makeDocument('orders', dId);
    store.store('orders', dId, doc);

    expect(store.retrieve('orders', dId)).toEqual(doc);
    expect(store.has('orders', dId)).toBe(true);
  });

  it('scopes identity to (documentType, dId)', () => {
    const dId = makeDId('shared-id');
    const orderDoc = makeDocument('orders', dId, { versionNo: 1 });
    const customerDoc = makeDocument('customers', dId, { versionNo: 2 });

    store.store('orders', dId, orderDoc);
    store.store('customers', dId, customerDoc);

    expect(store.retrieve('orders', dId)?.versionNo).toBe(1);
    expect(store.retrieve('customers', dId)?.versionNo).toBe(2);
  });
});

// ─── T2.3: DISK strategy ────────────────────────────────────────────────────

describe('T2.3: DiskStore', () => {
  let store: DiskStore;

  beforeEach(() => {
    cleanupDisk();
    store = new DiskStore(TEST_DISK_DIR);
  });

  afterEach(() => {
    cleanupDisk();
  });

  it('stores and retrieves a document from disk', () => {
    const dId = makeDId('order-1');
    const doc = makeDocument('orders', dId);
    store.store('orders', dId, doc);

    const retrieved = store.retrieve('orders', dId);
    expect(retrieved?.dId).toEqual(dId);
    expect(retrieved?.documentType).toBe('orders');
    expect(retrieved?.versionNo).toBe(1);
  });

  it('returns undefined for non-existent document', () => {
    expect(store.retrieve('orders', makeDId('nope'))).toBeUndefined();
  });

  it('deletes a document from disk', () => {
    const dId = makeDId('order-1');
    store.store('orders', dId, makeDocument('orders', dId));

    expect(store.delete('orders', dId)).toBe(true);
    expect(store.retrieve('orders', dId)).toBeUndefined();
  });

  it('has() works correctly', () => {
    const dId = makeDId('order-1');
    expect(store.has('orders', dId)).toBe(false);
    store.store('orders', dId, makeDocument('orders', dId));
    expect(store.has('orders', dId)).toBe(true);
  });

  it('count() counts persisted files', () => {
    store.store('orders', makeDId('o1'), makeDocument('orders', makeDId('o1')));
    store.store('orders', makeDId('o2'), makeDocument('orders', makeDId('o2')));
    expect(store.count()).toBe(2);
  });

  it('clear() removes all files', () => {
    store.store('orders', makeDId('o1'), makeDocument('orders', makeDId('o1')));
    store.clear();
    expect(store.count()).toBe(0);
  });

  it('preserves Map structures through serialisation round-trip', () => {
    const dId = makeDId('order-1');
    const doc = makeDocument('orders', dId);
    store.store('orders', dId, doc);

    const retrieved = store.retrieve('orders', dId);
    expect(retrieved?.root.children).toBeInstanceOf(Map);
    expect(retrieved?.root.children.size).toBe(1);
  });
});

// ─── T2.4: HYBRID strategy ─────────────────────────────────────────────────

describe('T2.4: HybridStore', () => {
  let store: HybridStore;

  beforeEach(() => {
    cleanupDisk();
    store = new HybridStore(TEST_DISK_DIR);
  });

  afterEach(() => {
    cleanupDisk();
  });

  it('stores to both memory and disk (write-through)', () => {
    const dId = makeDId('order-1');
    const doc = makeDocument('orders', dId);
    store.store('orders', dId, doc);

    // Verify retrieval (from memory)
    expect(store.retrieve('orders', dId)?.versionNo).toBe(1);

    // Create a new DiskStore pointing to same dir to verify disk persistence
    const diskCheck = new DiskStore(TEST_DISK_DIR);
    expect(diskCheck.retrieve('orders', dId)?.versionNo).toBe(1);
  });

  it('warms up memory from disk on construction', () => {
    const dId = makeDId('order-1');
    const doc = makeDocument('orders', dId);

    // Write directly to disk
    const disk = new DiskStore(TEST_DISK_DIR);
    disk.store('orders', dId, doc);

    // Create a new HybridStore — should warm up from disk
    const newHybrid = new HybridStore(TEST_DISK_DIR);
    expect(newHybrid.retrieve('orders', dId)?.versionNo).toBe(1);
  });

  it('delete removes from both layers', () => {
    const dId = makeDId('order-1');
    store.store('orders', dId, makeDocument('orders', dId));

    store.delete('orders', dId);
    expect(store.retrieve('orders', dId)).toBeUndefined();

    const diskCheck = new DiskStore(TEST_DISK_DIR);
    expect(diskCheck.retrieve('orders', dId)).toBeUndefined();
  });
});

// ─── T2.5, T2.6, T2.7: StorageManager (AUTO, switching, mode exposure) ─────

describe('T2.5–T2.7: StorageManager', () => {
  let manager: StorageManager;

  beforeEach(() => {
    cleanupDisk();
    manager = new StorageManager({ mode: 'memory', diskDir: TEST_DISK_DIR });
  });

  afterEach(() => {
    manager.clear();
    cleanupDisk();
  });

  // T2.7: mode exposure
  it('exposes current strategy mode', () => {
    expect(manager.getStrategy()).toBe('memory');
  });

  // T2.6: runtime switching
  it('switches strategy at runtime', () => {
    manager.setStrategy('disk');
    expect(manager.getStrategy()).toBe('disk');
  });

  it('no-ops when switching to the same mode', () => {
    manager.setStrategy('memory');
    expect(manager.getStrategy()).toBe('memory');
  });

  // Basic storage operations in MEMORY mode
  it('stores and retrieves in memory mode', () => {
    const dId = makeDId('order-1');
    const doc = makeDocument('orders', dId);
    manager.store('orders', dId, doc);

    expect(manager.retrieve('orders', dId)?.versionNo).toBe(1);
  });

  // DISK mode
  it('stores and retrieves in disk mode', () => {
    manager.setStrategy('disk');
    const dId = makeDId('order-1');
    const doc = makeDocument('orders', dId);
    manager.store('orders', dId, doc);

    expect(manager.retrieve('orders', dId)?.versionNo).toBe(1);
  });

  // AUTO mode (T2.5)
  it('auto mode stores documents (memory path for small docs)', () => {
    manager.setStrategy('auto');
    const dId = makeDId('order-1');
    const doc = makeDocument('orders', dId);
    manager.store('orders', dId, doc);

    // Should be retrievable (likely went to memory given small doc size)
    expect(manager.retrieve('orders', dId)?.versionNo).toBe(1);
  });

  // Strategy switching with data migration
  it('migrates data from memory to disk when switching modes', () => {
    const dId = makeDId('order-1');
    manager.store('orders', dId, makeDocument('orders', dId));

    manager.setStrategy('disk');
    // Document should still be accessible after migration
    expect(manager.retrieve('orders', dId)?.versionNo).toBe(1);
  });

  // HYBRID mode
  it('stores and retrieves in hybrid mode', () => {
    manager.setStrategy('hybrid');
    const dId = makeDId('order-1');
    const doc = makeDocument('orders', dId);
    manager.store('orders', dId, doc);

    expect(manager.retrieve('orders', dId)?.versionNo).toBe(1);
  });

  // count and clear
  it('count works across strategies', () => {
    manager.store('orders', makeDId('o1'), makeDocument('orders', makeDId('o1')));
    manager.store('orders', makeDId('o2'), makeDocument('orders', makeDId('o2')));
    expect(manager.count()).toBe(2);
  });

  it('clear removes all documents', () => {
    manager.store('orders', makeDId('o1'), makeDocument('orders', makeDId('o1')));
    manager.clear();
    expect(manager.count()).toBe(0);
  });
});
