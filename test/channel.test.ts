/**
 * Unit tests for Component 5: Channel Resolver
 *
 * Covers T5.1 (URL parsing), T5.2/T5.2b (registration + uniqueness),
 * T5.3 (update), T5.4 (deletion), T5.5 (status), T5.6 (activate/deactivate),
 * T5.7 (resolution logic), T5.8 (explicit override), T5.9 (initial status),
 * T5.10 (ChannelResolution structure).
 */

import { describe, it, expect } from 'vitest';
import { DocumentTypeRegistryImpl } from '../src/document-type/document-type-registry.js';
import { ChannelResolverImpl } from '../src/channel/channel-resolver.js';

// ─── Test Setup ─────────────────────────────────────────────────────────────

function setup() {
  const docTypeRegistry = new DocumentTypeRegistryImpl();
  docTypeRegistry.register({ name: 'orders', masterSchema: 'order-master-v1', model: 'closed' });
  docTypeRegistry.register({ name: 'customers', masterSchema: 'customer-master-v1', model: 'closed' });

  const resolver = new ChannelResolverImpl(docTypeRegistry);
  return { docTypeRegistry, resolver };
}

// ─── T5.1: URL Path Parsing ─────────────────────────────────────────────────

describe('T5.1: URL Path Parsing', () => {
  it('parses documentType-level path', () => {
    const { resolver } = setup();
    const result = resolver.parseUrl('/api/v1/ingest/orders');
    expect(result).toEqual({ documentType: 'orders' });
  });

  it('parses channel-level path', () => {
    const { resolver } = setup();
    const result = resolver.parseUrl('/api/v1/ingest/orders/channel-1');
    expect(result).toEqual({ documentType: 'orders', channelId: 'channel-1' });
  });

  it('returns undefined for non-ingest paths', () => {
    const { resolver } = setup();
    expect(resolver.parseUrl('/api/v1/documents/orders/123')).toBeUndefined();
  });

  it('returns undefined for empty path', () => {
    const { resolver } = setup();
    expect(resolver.parseUrl('')).toBeUndefined();
  });

  it('returns undefined for path with too many segments', () => {
    const { resolver } = setup();
    expect(resolver.parseUrl('/api/v1/ingest/orders/channel/extra')).toBeUndefined();
  });
});

// ─── T5.2 & T5.2b: Channel Registration ────────────────────────────────────

describe('T5.2 & T5.2b: Channel Registration', () => {
  it('registers a channel successfully', () => {
    const { resolver } = setup();
    const result = resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.channelId).toBe('ch-1');
    expect(result.config.documentType).toBe('orders');
    expect(result.config.status).toBe('active');
    expect(result.config.endpoint).toBe('/api/v1/ingest/orders/ch-1');
  });

  it('registers with optional Channel_Schema', () => {
    const { resolver } = setup();
    const result = resolver.register({
      channelId: 'ch-1',
      documentType: 'orders',
      channelSchema: 'order-channel-v1',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.channelSchema).toBe('order-channel-v1');
  });

  it('rejects duplicate channelId (global uniqueness - T5.2b)', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    const result = resolver.register({ channelId: 'ch-1', documentType: 'customers' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('CHANNEL_ALREADY_EXISTS');
  });

  it('rejects registration for non-existent Document_Type', () => {
    const { resolver } = setup();
    const result = resolver.register({ channelId: 'ch-1', documentType: 'nope' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('DOCUMENT_TYPE_NOT_FOUND');
  });

  it('adds channel to Document_Type registry', () => {
    const { docTypeRegistry, resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    expect(docTypeRegistry.get('orders')?.channels).toContain('ch-1');
  });
});

// ─── T5.9: Initial Status ───────────────────────────────────────────────────

describe('T5.9: Initial Status', () => {
  it('defaults to active', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    expect(resolver.get('ch-1')?.status).toBe('active');
  });

  it('can be created as inactive', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders', initialStatus: 'inactive' });
    expect(resolver.get('ch-1')?.status).toBe('inactive');
  });
});

// ─── T5.3: Channel Update ───────────────────────────────────────────────────

describe('T5.3: Channel Update', () => {
  it('updates Channel_Schema', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    const result = resolver.update('ch-1', { channelSchema: 'new-schema-v2' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.config.channelSchema).toBe('new-schema-v2');
  });

  it('removes Channel_Schema with null', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders', channelSchema: 'old' });
    resolver.update('ch-1', { channelSchema: null });
    expect(resolver.get('ch-1')?.channelSchema).toBeUndefined();
  });

  it('rejects update of non-existent channel', () => {
    const { resolver } = setup();
    const result = resolver.update('nope', { channelSchema: 's1' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('CHANNEL_NOT_FOUND');
  });
});

// ─── T5.4: Channel Deletion ─────────────────────────────────────────────────

describe('T5.4: Channel Deletion', () => {
  it('deletes a channel', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    const result = resolver.delete('ch-1');
    expect(result.success).toBe(true);
    expect(resolver.get('ch-1')).toBeUndefined();
  });

  it('removes channel from Document_Type registry', () => {
    const { docTypeRegistry, resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    resolver.delete('ch-1');
    expect(docTypeRegistry.get('orders')?.channels).not.toContain('ch-1');
  });

  it('rejects deletion of non-existent channel', () => {
    const { resolver } = setup();
    const result = resolver.delete('nope');
    expect(result.success).toBe(false);
    expect(result.code).toBe('CHANNEL_NOT_FOUND');
  });
});

// ─── T5.5 & T5.6: Status Management ────────────────────────────────────────

describe('T5.5 & T5.6: Status Management', () => {
  it('activates an inactive channel', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders', initialStatus: 'inactive' });
    const result = resolver.activate('ch-1');
    expect(result.success).toBe(true);
    expect(resolver.get('ch-1')?.status).toBe('active');
  });

  it('deactivates an active channel', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    const result = resolver.deactivate('ch-1');
    expect(result.success).toBe(true);
    expect(resolver.get('ch-1')?.status).toBe('inactive');
  });

  it('rejects activation of blocked channel (Req 47.14)', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    resolver.block('ch-1');
    const result = resolver.activate('ch-1');
    expect(result.success).toBe(false);
    expect(result.code).toBe('CHANNEL_BLOCKED');
  });

  it('rejects deactivation of blocked channel', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    resolver.block('ch-1');
    const result = resolver.deactivate('ch-1');
    expect(result.success).toBe(false);
    expect(result.code).toBe('CHANNEL_BLOCKED');
  });

  it('blocks an active channel', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    resolver.block('ch-1');
    expect(resolver.get('ch-1')?.status).toBe('blocked');
  });

  it('blocks an inactive channel (conflict takes precedence)', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders', initialStatus: 'inactive' });
    resolver.block('ch-1');
    expect(resolver.get('ch-1')?.status).toBe('blocked');
  });
});

// ─── T5.7: Resolution Logic ────────────────────────────────────────────────

describe('T5.7: Resolution Logic', () => {
  it('resolves documentType-level endpoint to Master_Schema', () => {
    const { resolver } = setup();
    const result = resolver.resolve('/api/v1/ingest/orders');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.resolution.documentType).toBe('orders');
    expect(result.resolution.applicableSchema).toBe('order-master-v1');
    expect(result.resolution.channelId).toBeUndefined();
    expect(result.resolution.source).toBe('url');
  });

  it('resolves channel with Channel_Schema', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders', channelSchema: 'order-ch-v1' });
    const result = resolver.resolve('/api/v1/ingest/orders/ch-1');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.resolution.applicableSchema).toBe('order-ch-v1');
    expect(result.resolution.channelId).toBe('ch-1');
  });

  it('falls back to Master_Schema when channel has no Channel_Schema', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    const result = resolver.resolve('/api/v1/ingest/orders/ch-1');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.resolution.applicableSchema).toBe('order-master-v1');
  });

  it('rejects with DOCUMENT_TYPE_NOT_FOUND', () => {
    const { resolver } = setup();
    const result = resolver.resolve('/api/v1/ingest/unknown');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('DOCUMENT_TYPE_NOT_FOUND');
  });

  it('rejects with CHANNEL_NOT_FOUND', () => {
    const { resolver } = setup();
    const result = resolver.resolve('/api/v1/ingest/orders/nonexistent');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('rejects with CHANNEL_INACTIVE', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders', initialStatus: 'inactive' });
    const result = resolver.resolve('/api/v1/ingest/orders/ch-1');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('CHANNEL_INACTIVE');
  });

  it('rejects with CHANNEL_BLOCKED', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    resolver.block('ch-1');
    const result = resolver.resolve('/api/v1/ingest/orders/ch-1');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('CHANNEL_BLOCKED');
  });
});

// ─── T5.8: Explicit Override ────────────────────────────────────────────────

describe('T5.8: Explicit Override', () => {
  it('uses explicit Document_Type when provided', () => {
    const { resolver } = setup();
    const result = resolver.resolve('/api/v1/ingest/orders', { documentType: 'customers' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.resolution.documentType).toBe('customers');
    expect(result.resolution.applicableSchema).toBe('customer-master-v1');
  });

  it('generates override warning when explicit differs from URL', () => {
    const { resolver } = setup();
    const result = resolver.resolve('/api/v1/ingest/orders', { documentType: 'customers' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.resolution.overrideWarning).toBeDefined();
    expect(result.resolution.source).toBe('explicit');
  });

  it('uses explicit schema when provided', () => {
    const { resolver } = setup();
    const result = resolver.resolve('/api/v1/ingest/orders', { schema: 'my-explicit-schema' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.resolution.applicableSchema).toBe('my-explicit-schema');
    expect(result.resolution.source).toBe('explicit');
  });

  it('no warning when explicit matches URL', () => {
    const { resolver } = setup();
    const result = resolver.resolve('/api/v1/ingest/orders', { documentType: 'orders' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.resolution.overrideWarning).toBeUndefined();
  });
});

// ─── T5.10: List Channels ───────────────────────────────────────────────────

describe('T5.10: Channel Listing', () => {
  it('lists all channels', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    resolver.register({ channelId: 'ch-2', documentType: 'customers' });
    expect(resolver.list()).toHaveLength(2);
  });

  it('lists channels filtered by Document_Type', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'ch-1', documentType: 'orders' });
    resolver.register({ channelId: 'ch-2', documentType: 'orders' });
    resolver.register({ channelId: 'ch-3', documentType: 'customers' });
    expect(resolver.list('orders')).toHaveLength(2);
    expect(resolver.list('customers')).toHaveLength(1);
  });
});

// ─── 0.3.1 fix: enrichment bindings read-through (defect-enrichment-bindings) ─

describe('Enrichment bindings read-through (Req 47 / defect-enrichment-bindings)', () => {
  it('list()/get() reflect the Enrichment Engine bindings instead of hardcoded []', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'consignment', documentType: 'orders' });

    // Simulate the Enrichment Engine as the source of truth (as wired in main()).
    const engineBindings = new Map<string, { fieldPath: string; staticValue: unknown }[]>();
    resolver.setEnrichmentBindingsProvider((channelId) => engineBindings.get(channelId) ?? []);

    // Before any bindings: empty (but sourced from the engine, not a placeholder).
    expect(resolver.get('consignment')!.enrichmentBindings).toEqual([]);

    // Register bindings in the engine.
    engineBindings.set('consignment', [
      { fieldPath: 'author', staticValue: 'Teneris' },
      { fieldPath: 'url', staticValue: 'teneris.cc' },
    ]);

    const viaGet = resolver.get('consignment')!;
    expect(viaGet.enrichmentBindings).toHaveLength(2);
    expect(viaGet.enrichmentBindings.map((b) => b.fieldPath)).toEqual(['author', 'url']);

    const viaList = resolver.list('orders').find((c) => c.channelId === 'consignment')!;
    expect(viaList.enrichmentBindings).toHaveLength(2);
  });

  it('falls back to [] when no provider is wired (no crash)', () => {
    const { resolver } = setup();
    resolver.register({ channelId: 'consignment', documentType: 'orders' });
    expect(resolver.get('consignment')!.enrichmentBindings).toEqual([]);
  });
});
