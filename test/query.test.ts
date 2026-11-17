/**
 * Unit tests for Component 9: Query Engine
 *
 * Covers T9.1 (full retrieval), T9.2 (glob), T9.3 (leaf by path),
 * T9.4 (bunch by path), T9.5–T9.7 (retrieval modes), T9.8 (value search),
 * T9.11 (TTL check hook), T9.12 (not-found reasons).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../src/storage/memory-store.js';
import { QueryEngineImpl } from '../src/query/query-engine.js';
import type { InternalDocument, StoredBunch, StoredLeaf } from '../src/storage/types.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeStoredLeaf(value: unknown): StoredLeaf {
  return { value, metadata: { timestampRef: { index: 0 }, versionNo: 1 }, history: [] };
}

function makeDoc(dIdValue: string, fields: Record<string, unknown>, overrides: Partial<InternalDocument> = {}): InternalDocument {
  const children = new Map<string, StoredBunch | StoredLeaf>();
  for (const [key, val] of Object.entries(fields)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const nested = new Map<string, StoredLeaf>();
      for (const [nk, nv] of Object.entries(val as Record<string, unknown>)) {
        nested.set(nk, makeStoredLeaf(nv));
      }
      children.set(key, {
        metadata: { timestampRef: { index: 0 }, versionNo: 1, history: [] },
        children: nested,
      } as StoredBunch);
    } else {
      children.set(key, makeStoredLeaf(val));
    }
  }

  const root: StoredBunch = {
    metadata: { timestampRef: { index: 0 }, versionNo: 1, history: [] },
    children,
  };

  return {
    dId: { type: 'single', value: dIdValue },
    documentType: 'orders',
    timestampList: [{ requestTime: '2026-01-01T00:00:00Z', commitTime: '2026-01-01T00:00:01Z', channelIdentifier: 'default' }],
    versionNo: 1,
    historyDepth: 5,
    model: 'closed',
    root,
    softDeleted: false,
    ...overrides,
  };
}

let storage: MemoryStore;
let query: QueryEngineImpl;

beforeEach(() => {
  storage = new MemoryStore();
  query = new QueryEngineImpl(storage);

  // Seed test data
  storage.store('orders', { type: 'single', value: 'order-1' }, makeDoc('order-1', { name: 'Alpha', amount: 100, tags: ['a', 'b'] }));
  storage.store('orders', { type: 'single', value: 'order-2' }, makeDoc('order-2', { name: 'Beta', amount: 200 }));
  storage.store('orders', { type: 'single', value: 'order-3' }, makeDoc('order-3', { name: 'Gamma', amount: 100 }));
  storage.store('orders', { type: 'single', value: 'deleted-1' }, makeDoc('deleted-1', { name: 'Deleted' }, { softDeleted: true, softDeleteType: 'explicit' }));
});

// ─── T9.1: Full Document Retrieval ──────────────────────────────────────────

describe('T9.1: Full Document Retrieval', () => {
  it('retrieves a document by exact D-Id', () => {
    const result = query.retrieveDocument('orders', { type: 'single', value: 'order-1' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.document['name']).toBe('Alpha');
    expect(result.document['amount']).toBe(100);
  });

  it('returns not-found for non-existent D-Id', () => {
    const result = query.retrieveDocument('orders', { type: 'single', value: 'nope' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('DOCUMENT_NOT_FOUND');
    expect(result.reason).toBeNull();
  });

  it('excludes soft-deleted documents (T9.12)', () => {
    const result = query.retrieveDocument('orders', { type: 'single', value: 'deleted-1' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('explicit-soft-deleted');
  });
});

// ─── T9.2: Glob Pattern Matching ────────────────────────────────────────────

describe('T9.2: Glob Pattern Matching', () => {
  it('matches with * wildcard', () => {
    const result = query.retrieveByGlob('orders', { type: 'single', value: 'order-*' });
    expect(result.success).toBe(true);
    expect(result.documents.length).toBe(3);
  });

  it('matches with ? wildcard', () => {
    const result = query.retrieveByGlob('orders', { type: 'single', value: 'order-?' });
    expect(result.success).toBe(true);
    expect(result.documents.length).toBe(3); // order-1, order-2, order-3
  });

  it('returns empty for no matches', () => {
    const result = query.retrieveByGlob('orders', { type: 'single', value: 'xyz-*' });
    expect(result.documents.length).toBe(0);
  });

  it('excludes soft-deleted from glob results', () => {
    const result = query.retrieveByGlob('orders', { type: 'single', value: '*' });
    // 3 active orders, deleted-1 excluded
    expect(result.documents.length).toBe(3);
  });

  it('supports composed D-Id glob matching per component', () => {
    storage.store('shipments', { type: 'composed', parts: ['customer-A', 'ship-1'] },
      makeDoc('customer-A:ship-1', { status: 'pending' }, { documentType: 'shipments', dId: { type: 'composed', parts: ['customer-A', 'ship-1'] } }));
    storage.store('shipments', { type: 'composed', parts: ['customer-A', 'ship-2'] },
      makeDoc('customer-A:ship-2', { status: 'done' }, { documentType: 'shipments', dId: { type: 'composed', parts: ['customer-A', 'ship-2'] } }));
    storage.store('shipments', { type: 'composed', parts: ['customer-B', 'ship-3'] },
      makeDoc('customer-B:ship-3', { status: 'done' }, { documentType: 'shipments', dId: { type: 'composed', parts: ['customer-B', 'ship-3'] } }));

    const result = query.retrieveByGlob('shipments', { type: 'composed', parts: ['customer-A', '*'] });
    expect(result.documents.length).toBe(2);
  });
});

// ─── T9.3: Leaf Retrieval by Path ───────────────────────────────────────────

describe('T9.3: Leaf Retrieval by Path', () => {
  it('retrieves a leaf by dot-notation path', () => {
    const result = query.retrieveLeaf('orders', { type: 'single', value: 'order-1' }, 'name');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.document['_value']).toBe('Alpha');
  });

  it('returns error for invalid path', () => {
    const result = query.retrieveLeaf('orders', { type: 'single', value: 'order-1' }, 'nonexistent');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('INVALID_PATH');
  });
});

// ─── T9.4: Bunch Retrieval by Path ──────────────────────────────────────────

describe('T9.4: Bunch Retrieval by Path', () => {
  it('retrieves a nested bunch', () => {
    // Add a doc with nested object
    storage.store('orders', { type: 'single', value: 'nested-1' }, makeDoc('nested-1', {
      name: 'Nested',
      address: { city: 'Berlin', zip: '10115' },
    }));

    const result = query.retrieveBunch('orders', { type: 'single', value: 'nested-1' }, 'address');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.document['city']).toBe('Berlin');
    expect(result.document['zip']).toBe('10115');
  });
});

// ─── T9.5–T9.7: Retrieval Modes ────────────────────────────────────────────

describe('T9.5–T9.7: Retrieval Modes', () => {
  it('full mode returns all fields (default)', () => {
    const result = query.retrieveDocument('orders', { type: 'single', value: 'order-1' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.document).sort()).toEqual(['amount', 'name', 'tags']);
  });

  it('closed mode returns only schema-specified fields (T9.5)', () => {
    const result = query.retrieveDocument('orders', { type: 'single', value: 'order-1' }, {
      mode: 'closed',
      retrievalSchema: { properties: { name: { type: 'string' } } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.document)).toEqual(['name']);
  });

  it('open mode returns all fields (T9.6)', () => {
    const result = query.retrieveDocument('orders', { type: 'single', value: 'order-1' }, {
      mode: 'open',
      retrievalSchema: { properties: { name: { type: 'string' } } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.document).sort()).toEqual(['amount', 'name', 'tags']);
  });

  it('full mode ignores schema (T9.7)', () => {
    const result = query.retrieveDocument('orders', { type: 'single', value: 'order-1' }, {
      mode: 'full',
      retrievalSchema: { properties: { name: { type: 'string' } } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.document).length).toBe(3);
  });
});

// ─── T9.8: Value-Based Search ───────────────────────────────────────────────

describe('T9.8: Value-Based Search', () => {
  it('finds documents by leaf value', () => {
    const result = query.searchByValue('orders', 'amount', 100);
    expect(result.success).toBe(true);
    expect(result.matches.length).toBe(2); // order-1 and order-3
  });

  it('returns empty when no match', () => {
    const result = query.searchByValue('orders', 'amount', 999);
    expect(result.matches.length).toBe(0);
  });

  it('excludes soft-deleted from search', () => {
    const result = query.searchByValue('orders', 'name', 'Deleted');
    expect(result.matches.length).toBe(0);
  });
});

// ─── T9.11: TTL Check Hook ──────────────────────────────────────────────────

describe('T9.11: On-Access TTL Check', () => {
  it('returns document when TTL check passes', () => {
    query.setTtlChecker(() => ({ valid: true }));
    const result = query.retrieveDocument('orders', { type: 'single', value: 'order-1' });
    expect(result.success).toBe(true);
  });

  it('rejects when TTL check fails', () => {
    query.setTtlChecker(() => ({ valid: false, action: 'reject', reason: 'ttl-expired' }));
    const result = query.retrieveDocument('orders', { type: 'single', value: 'order-1' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('ttl-expired');
  });
});

// ─── T9.12: Not-Found Reasons ───────────────────────────────────────────────

describe('T9.12: Not-Found Reasons', () => {
  it('null reason for genuinely non-existent document', () => {
    const result = query.retrieveDocument('orders', { type: 'single', value: 'nope' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBeNull();
  });

  it('explicit-soft-deleted reason', () => {
    const result = query.retrieveDocument('orders', { type: 'single', value: 'deleted-1' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('explicit-soft-deleted');
  });

  it('ttl-expired reason from TTL checker', () => {
    query.setTtlChecker(() => ({ valid: false, reason: 'absolute-expired' }));
    const result = query.retrieveDocument('orders', { type: 'single', value: 'order-1' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe('absolute-expired');
  });
});
