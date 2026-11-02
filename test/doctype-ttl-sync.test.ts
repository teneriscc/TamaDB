/**
 * Regression tests for the 0.3.1 Document_Type TTL divergence fix.
 *
 * Before the fix, a Document_Type TTL could live in two disjoint stores that
 * never synced: the registry entry's `ttl` (create/update, GET-visible) and the
 * TtlManager's docTypeTtls (PUT .../ttl, governs expiry). These tests assert the
 * two now agree via the HTTP surface, and that the new effective-TTL GET exists.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
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

let app: FastifyInstance;

beforeEach(async () => {
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

  const ctx: AppContext = {
    storage, storageManager, schemaManager, docTypeRegistry, channelResolver,
    didExtractor, versionManager, enrichmentEngine, documentManager, queryEngine,
    ttlManager, quarantineStore, subscriptionManager, webhookDispatcher, dIdDelimiter: ':',
  };

  app = Fastify({ logger: false });
  registerAllRoutes(app, ctx);
  await app.ready();

  schemaManager.register({
    ref: 'order-v1',
    schema: {
      type: 'object',
      properties: { orderId: { type: 'integer', identityKind: 'primary-key' }, name: { type: 'string' } },
      required: ['orderId', 'name'],
    },
  });
});

describe('Document_Type TTL source-of-truth unification (Req 37)', () => {
  it('a creation-time TTL governs expiry (seeded into the effective TTL)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/config/document-types',
      payload: { name: 'orders', masterSchema: 'order-v1', model: 'closed', ttl: 3600 },
    });

    // The effective (governing) TTL endpoint must reflect the creation-time TTL.
    const eff = await app.inject({ method: 'GET', url: '/api/v1/config/ttl/document-type/orders' });
    expect(eff.statusCode).toBe(200);
    expect(eff.json().ttl).toBe(3600);
  });

  it('a PUT .../ttl is reflected in GET /config/document-types/{type}', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/config/document-types',
      payload: { name: 'orders', masterSchema: 'order-v1', model: 'closed' },
    });

    await app.inject({ method: 'PUT', url: '/api/v1/config/document-types/orders/ttl', payload: { ttl: 1800 } });

    // Registry entry now mirrors the governing value.
    const get = await app.inject({ method: 'GET', url: '/api/v1/config/document-types/orders' });
    expect(get.json().ttl).toBe(1800);

    // And the effective GET agrees.
    const eff = await app.inject({ method: 'GET', url: '/api/v1/config/ttl/document-type/orders' });
    expect(eff.json().ttl).toBe(1800);
  });

  it('registry entry and effective TTL agree after both a creation TTL and a later PUT', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/config/document-types',
      payload: { name: 'orders', masterSchema: 'order-v1', model: 'closed', ttl: 3600 },
    });
    await app.inject({ method: 'PUT', url: '/api/v1/config/document-types/orders/ttl', payload: { ttl: 60 } });

    const get = await app.inject({ method: 'GET', url: '/api/v1/config/document-types/orders' });
    const eff = await app.inject({ method: 'GET', url: '/api/v1/config/ttl/document-type/orders' });
    expect(get.json().ttl).toBe(60);
    expect(eff.json().ttl).toBe(60);
  });

  it('effective-TTL GET returns 404 for an unknown Document_Type', async () => {
    const eff = await app.inject({ method: 'GET', url: '/api/v1/config/ttl/document-type/nope' });
    expect(eff.statusCode).toBe(404);
  });
});
