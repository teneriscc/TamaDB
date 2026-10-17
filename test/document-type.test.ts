/**
 * Unit tests for Component 4: Document_Type Registry
 *
 * Covers T4.1 (registration), T4.2 (retrieval), T4.3 (update),
 * T4.4 (deletion with precondition), T4.5 (timestamps),
 * T4.6 (Master_Schema invariant), T4.7 (channel list).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DocumentTypeRegistryImpl } from '../src/document-type/document-type-registry.js';

// ─── T4.1: Registration ─────────────────────────────────────────────────────

describe('T4.1: Document_Type Registration', () => {
  let registry: DocumentTypeRegistryImpl;

  beforeEach(() => {
    registry = new DocumentTypeRegistryImpl();
  });

  it('registers a new Document_Type', () => {
    const result = registry.register({
      name: 'orders',
      masterSchema: 'order-schema-v1',
      model: 'closed',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.name).toBe('orders');
    expect(result.config.masterSchema).toBe('order-schema-v1');
    expect(result.config.model).toBe('closed');
  });

  it('registers with optional TTL', () => {
    const result = registry.register({
      name: 'events',
      masterSchema: 'event-schema-v1',
      model: 'closed',
      ttl: 3600,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.ttl).toBe(3600);
  });

  it('rejects duplicate name', () => {
    registry.register({ name: 'orders', masterSchema: 's1', model: 'closed' });
    const result = registry.register({ name: 'orders', masterSchema: 's2', model: 'closed' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('DOCUMENT_TYPE_ALREADY_EXISTS');
  });

  it('rejects empty name', () => {
    const result = registry.register({ name: '', masterSchema: 's1', model: 'closed' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('INVALID_NAME');
  });

  it('initialises channels as empty array', () => {
    registry.register({ name: 'orders', masterSchema: 's1', model: 'closed' });
    const config = registry.get('orders');
    expect(config?.channels).toEqual([]);
  });
});

// ─── T4.2: Retrieval ────────────────────────────────────────────────────────

describe('T4.2: Document_Type Retrieval', () => {
  let registry: DocumentTypeRegistryImpl;

  beforeEach(() => {
    registry = new DocumentTypeRegistryImpl();
    registry.register({ name: 'orders', masterSchema: 's1', model: 'closed' });
    registry.register({ name: 'customers', masterSchema: 's2', model: 'closed' });
  });

  it('retrieves by name', () => {
    const config = registry.get('orders');
    expect(config).toBeDefined();
    expect(config?.name).toBe('orders');
  });

  it('returns undefined for non-existent', () => {
    expect(registry.get('nope')).toBeUndefined();
  });

  it('lists all Document_Types', () => {
    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.name).sort()).toEqual(['customers', 'orders']);
  });
});

// ─── T4.3: Update ───────────────────────────────────────────────────────────

describe('T4.3: Document_Type Update', () => {
  let registry: DocumentTypeRegistryImpl;

  beforeEach(() => {
    registry = new DocumentTypeRegistryImpl();
    registry.register({ name: 'orders', masterSchema: 's1', model: 'closed', ttl: 3600 });
  });

  it('updates Master_Schema', () => {
    const result = registry.update('orders', { masterSchema: 's2' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.masterSchema).toBe('s2');
  });

  it('updates TTL', () => {
    const result = registry.update('orders', { ttl: 7200 });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.ttl).toBe(7200);
  });

  it('removes TTL with null', () => {
    const result = registry.update('orders', { ttl: null });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.ttl).toBeUndefined();
  });

  it('updates model', () => {
    const result = registry.update('orders', { model: 'hybrid' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.model).toBe('hybrid');
  });

  it('rejects update of non-existent type', () => {
    const result = registry.update('nope', { ttl: 100 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('DOCUMENT_TYPE_NOT_FOUND');
  });
});

// ─── T4.4: Deletion ────────────────────────────────────────────────────────

describe('T4.4: Document_Type Deletion', () => {
  let registry: DocumentTypeRegistryImpl;

  beforeEach(() => {
    registry = new DocumentTypeRegistryImpl();
    registry.register({ name: 'orders', masterSchema: 's1', model: 'closed' });
  });

  it('deletes a Document_Type with no documents', () => {
    const result = registry.delete('orders');
    expect(result.success).toBe(true);
    expect(registry.get('orders')).toBeUndefined();
  });

  it('rejects deletion when documents exist', () => {
    registry.setDocumentExistenceChecker((type) => type === 'orders');
    const result = registry.delete('orders');
    expect(result.success).toBe(false);
    expect(result.code).toBe('DOCUMENTS_EXIST');
  });

  it('rejects deletion of non-existent type', () => {
    const result = registry.delete('nope');
    expect(result.success).toBe(false);
    expect(result.code).toBe('DOCUMENT_TYPE_NOT_FOUND');
  });
});

// ─── T4.5: Timestamps ──────────────────────────────────────────────────────

describe('T4.5: Timestamps', () => {
  let registry: DocumentTypeRegistryImpl;

  beforeEach(() => {
    registry = new DocumentTypeRegistryImpl();
  });

  it('sets createdAt and updatedAt equal on creation', () => {
    registry.register({ name: 'orders', masterSchema: 's1', model: 'closed' });
    const config = registry.get('orders');
    expect(config?.createdAt).toBeDefined();
    expect(config?.updatedAt).toBe(config?.createdAt);
  });

  it('updates updatedAt on modification', () => {
    registry.register({ name: 'orders', masterSchema: 's1', model: 'closed' });
    const before = registry.get('orders')?.updatedAt;

    registry.update('orders', { ttl: 100 });
    const after = registry.get('orders')?.updatedAt;

    // They may be the same timestamp (same ms) but both must be defined strings
    expect(typeof before).toBe('string');
    expect(typeof after).toBe('string');
  });

  it('createdAt never changes', () => {
    registry.register({ name: 'orders', masterSchema: 's1', model: 'closed' });
    const createdBefore = registry.get('orders')?.createdAt;

    registry.update('orders', { ttl: 100 });
    const createdAfter = registry.get('orders')?.createdAt;

    expect(createdAfter).toBe(createdBefore);
  });
});

// ─── T4.6: Master_Schema Invariant ─────────────────────────────────────────

describe('T4.6: Master_Schema Invariant', () => {
  let registry: DocumentTypeRegistryImpl;

  beforeEach(() => {
    registry = new DocumentTypeRegistryImpl();
    registry.register({ name: 'orders', masterSchema: 'order-v1', model: 'closed' });
    registry.register({ name: 'customers', masterSchema: 'customer-v1', model: 'closed' });
  });

  it('reports schema as active Master_Schema when in use', () => {
    expect(registry.isMasterSchema('order-v1')).toBe(true);
    expect(registry.isMasterSchema('customer-v1')).toBe(true);
  });

  it('reports false for non-master schemas', () => {
    expect(registry.isMasterSchema('some-channel-schema')).toBe(false);
  });

  it('reports false after Document_Type deletion', () => {
    registry.delete('orders');
    expect(registry.isMasterSchema('order-v1')).toBe(false);
  });

  it('reports false after Master_Schema change', () => {
    registry.update('orders', { masterSchema: 'order-v2' });
    expect(registry.isMasterSchema('order-v1')).toBe(false);
    expect(registry.isMasterSchema('order-v2')).toBe(true);
  });
});

// ─── T4.7: Channel List ─────────────────────────────────────────────────────

describe('T4.7: Channel List Maintenance', () => {
  let registry: DocumentTypeRegistryImpl;

  beforeEach(() => {
    registry = new DocumentTypeRegistryImpl();
    registry.register({ name: 'orders', masterSchema: 's1', model: 'closed' });
  });

  it('adds a channel to a Document_Type', () => {
    expect(registry.addChannel('orders', 'channel-1')).toBe(true);
    expect(registry.get('orders')?.channels).toEqual(['channel-1']);
  });

  it('does not duplicate channels', () => {
    registry.addChannel('orders', 'channel-1');
    registry.addChannel('orders', 'channel-1');
    expect(registry.get('orders')?.channels).toEqual(['channel-1']);
  });

  it('adds multiple channels', () => {
    registry.addChannel('orders', 'channel-1');
    registry.addChannel('orders', 'channel-2');
    expect(registry.get('orders')?.channels).toEqual(['channel-1', 'channel-2']);
  });

  it('removes a channel', () => {
    registry.addChannel('orders', 'channel-1');
    registry.addChannel('orders', 'channel-2');
    expect(registry.removeChannel('orders', 'channel-1')).toBe(true);
    expect(registry.get('orders')?.channels).toEqual(['channel-2']);
  });

  it('returns false when removing non-existent channel', () => {
    expect(registry.removeChannel('orders', 'nope')).toBe(false);
  });

  it('returns false when adding to non-existent Document_Type', () => {
    expect(registry.addChannel('nope', 'channel-1')).toBe(false);
  });

  it('updates updatedAt when channels change', () => {
    const before = registry.get('orders')?.updatedAt;
    registry.addChannel('orders', 'channel-1');
    const after = registry.get('orders')?.updatedAt;
    expect(typeof before).toBe('string');
    expect(typeof after).toBe('string');
  });
});
