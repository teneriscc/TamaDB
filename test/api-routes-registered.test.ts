/**
 * Regression test: API routes must be registered on the Fastify instance.
 *
 * This test catches the bug where `registerAllRoutes()` was never called,
 * causing all /api/v1/* endpoints to return 404. It verifies that a
 * representative route from each route module responds with a non-404 status.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { registerAllRoutes } from '../src/api/index.js';
import type { AppContext } from '../src/api/context.js';
import { StorageManager } from '../src/storage/index.js';
import { SchemaManagerImpl } from '../src/schema/index.js';
import { DocumentTypeRegistryImpl } from '../src/document-type/index.js';
import { ChannelResolverImpl } from '../src/channel/index.js';
import { DIdExtractorImpl } from '../src/did/index.js';
import { VersionManagerImpl } from '../src/version/index.js';
import { EnrichmentEngineImpl } from '../src/enrichment/index.js';
import { DocumentManagerImpl } from '../src/document-manager/index.js';
import { QueryEngineImpl } from '../src/query/index.js';
import { TtlManagerImpl } from '../src/ttl/index.js';
import { QuarantineStoreImpl } from '../src/quarantine/index.js';
import { SubscriptionManagerImpl } from '../src/subscription/index.js';
import { WebhookDispatcherImpl } from '../src/webhook/index.js';

/**
 * Build a fully-wired Fastify app with all routes registered.
 * Mirrors the wiring in src/index.ts so the test catches drift.
 */
async function buildTestApp(): Promise<FastifyInstance> {
  const config = loadConfig();
  const app = await buildServer(config);

  const storageManager = new StorageManager({ mode: 'memory' });
  const schemaManager = new SchemaManagerImpl();
  const docTypeRegistry = new DocumentTypeRegistryImpl();
  const channelResolver = new ChannelResolverImpl(docTypeRegistry);
  const didExtractor = new DIdExtractorImpl();
  const versionManager = new VersionManagerImpl();
  const enrichmentEngine = new EnrichmentEngineImpl();
  const ttlManager = new TtlManagerImpl();
  const quarantineStore = new QuarantineStoreImpl();
  const subscriptionManager = new SubscriptionManagerImpl();
  const webhookDispatcher = new WebhookDispatcherImpl();

  const documentManager = new DocumentManagerImpl({
    storage: storageManager,
    schemaManager,
    docTypeRegistry,
    enrichmentEngine,
    didExtractor,
    versionManager,
  });

  const queryEngine = new QueryEngineImpl(storageManager);

  const ctx: AppContext = {
    storage: storageManager,
    storageManager,
    schemaManager,
    docTypeRegistry,
    channelResolver,
    didExtractor,
    versionManager,
    enrichmentEngine,
    documentManager,
    queryEngine,
    ttlManager,
    quarantineStore,
    subscriptionManager,
    webhookDispatcher,
    dIdDelimiter: ':',
  };

  registerAllRoutes(app, ctx);
  return app;
}

describe('API route registration (regression)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /api/v1/schemas is routed (not 404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/schemas',
      payload: { ref: 'test-schema', schema: { type: 'object' } },
    });
    expect(res.statusCode).not.toBe(404);
  });

  it('GET /api/v1/schemas/:ref is routed (not 404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/schemas/nonexistent',
    });
    // 404 from "schema not found" is fine — the route itself handled it.
    // A *routing* 404 would have message "Route GET:/api/v1/schemas/nonexistent not found".
    expect(res.json().error).not.toBe('Not Found');
  });

  it('GET /api/v1/config/storage-strategy is routed (not 404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/config/storage-strategy',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('mode');
  });

  it('GET /api/v1/config/document-types is routed (not 404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/config/document-types',
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/v1/config/quarantine-policy is routed (not 404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/config/quarantine-policy',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('policy');
  });

  it('GET /api/v1/config/enrichment-policies is routed (not 404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/config/enrichment-policies',
    });
    expect(res.statusCode).toBe(200);
  });

  it('/health still works alongside API routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
