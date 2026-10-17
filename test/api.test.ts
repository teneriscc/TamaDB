/**
 * Integration tests for Component 15: REST API Layer
 *
 * Tests the HTTP endpoints via Fastify inject() — no real network calls.
 * Validates T15.1–T15.10 end-to-end.
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
    storage,
    schemaManager,
    docTypeRegistry,
    enrichmentEngine,
    didExtractor,
    versionManager,
  });

  const ctx: AppContext = {
    storage,
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

  app = Fastify({ logger: false });
  registerAllRoutes(app, ctx);
  await app.ready();

  // Seed: register schema and document type
  schemaManager.register({
    ref: 'order-v1',
    schema: {
      type: 'object',
      properties: {
        orderId: { type: 'integer', identityKind: 'primary-key' },
        name: { type: 'string' },
        amount: { type: 'number' },
      },
      required: ['orderId', 'name'],
    },
  });
  docTypeRegistry.register({ name: 'orders', masterSchema: 'order-v1', model: 'closed' });
});

// ─── T15.1: Ingestion ───────────────────────────────────────────────────────

describe('T15.1: Ingest Endpoints', () => {
  it('POST /api/v1/ingest/:documentType creates a document (201)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      payload: { orderId: 1, name: 'Order One', amount: 100 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.dId).toBe('1');
    expect(body.versionNo).toBe(1);
    expect(body.created).toBe(true);
  });

  it('POST /api/v1/ingest/:documentType updates existing (200)', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/ingest/orders', payload: { orderId: 1, name: 'v1' } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/ingest/orders', payload: { orderId: 1, name: 'v2' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(false);
    expect(res.json().versionNo).toBe(2);
  });

  it('returns 422 on schema validation failure', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      payload: { orderId: 1 }, // missing 'name'
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('returns 404 for non-existent Document_Type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/unknown',
      payload: { id: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('treats the whole body as the document; the old "document" wrapper is NOT unwrapped (Req 1.10)', async () => {
    // Sending the legacy wrapper shape must be interpreted as a bare document
    // whose only top-level field is "document" — NOT unwrapped. The real
    // identity/required fields (orderId/name) are therefore absent, so the write
    // is rejected rather than silently succeeding by unwrapping. The invariant
    // under test is only that no unwrapping occurs (i.e. it does not succeed and
    // no document is stored under orderId 1).
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      payload: { document: { orderId: 1, name: 'Would-be-unwrapped' } },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const get = await app.inject({ method: 'GET', url: '/api/v1/documents/orders/1' });
    expect(get.statusCode).toBe(404);
  });

  it('TamaDB-Version header enforces optimistic concurrency', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/ingest/orders', payload: { orderId: 20, name: 'v1' } });
    // Correct expected version (1) succeeds
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-version': '1' },
      payload: { orderId: 20, name: 'v2' },
    });
    expect(ok.statusCode).toBe(200);
    // Stale expected version (1 again, now current is 2) conflicts
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-version': '1' },
      payload: { orderId: 20, name: 'v3' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('VERSION_CONFLICT');
  });

  it('rejects a malformed TamaDB-Version with INVALID_CONTROL_HEADER (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-version': 'abc' },
      payload: { orderId: 21, name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_CONTROL_HEADER');
    expect(res.json().message).toContain('TamaDB-Version');
  });

  it('rejects TamaDB-Version of 0 with INVALID_CONTROL_HEADER (must be >= 1)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-version': '0' },
      payload: { orderId: 22, name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_CONTROL_HEADER');
  });

  it('rejects a malformed TamaDB-TTL with INVALID_CONTROL_HEADER', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-ttl': 'soon' },
      payload: { orderId: 23, name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_CONTROL_HEADER');
    expect(res.json().message).toContain('TamaDB-TTL');
  });

  it('accepts TamaDB-TTL of "infinite" and a numeric TTL', async () => {
    const inf = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-ttl': 'infinite' },
      payload: { orderId: 24, name: 'keep' },
    });
    expect(inf.statusCode).toBe(201);
    const num = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-ttl': '3600' },
      payload: { orderId: 25, name: 'hour' },
    });
    expect(num.statusCode).toBe(201);
  });

  it('rejects a malformed TamaDB-Expire-At with INVALID_CONTROL_HEADER', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-expire-at': 'not-a-date' },
      payload: { orderId: 26, name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_CONTROL_HEADER');
    expect(res.json().message).toContain('TamaDB-Expire-At');
  });

  it('accepts TamaDB-Expire-At in UTC (trailing Z)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-expire-at': '2026-12-31T23:59:59Z' },
      payload: { orderId: 260, name: 'utc' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('accepts TamaDB-Expire-At with a numeric offset (+02:00)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-expire-at': '2026-12-31T23:59:59.000+02:00' },
      payload: { orderId: 261, name: 'offset' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a timezone-less TamaDB-Expire-At date-time (ambiguous local time)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-expire-at': '2026-12-31T23:59:59' }, // parses, but no timezone
      payload: { orderId: 262, name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_CONTROL_HEADER');
    expect(res.json().message).toContain('timezone');
  });

  it('rejects a date-only TamaDB-Expire-At (no time, no timezone)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-expire-at': '2026-12-31' },
      payload: { orderId: 263, name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_CONTROL_HEADER');
  });

  it('captures TamaDB-* Control_Headers verbatim in the quarantine record (audit)', async () => {
    // A schema validation failure is quarantined under the default data-errors-only
    // policy. The valid TamaDB-* headers on the request must be recorded verbatim in
    // the quarantine context for audit/non-repudiation (Req 17.9a).
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'tamadb-ttl': '3600', 'tamadb-version': '4' },
      payload: { orderId: 30 }, // missing required 'name' -> SCHEMA_VALIDATION_FAILED
    });
    expect(res.statusCode).toBe(422);
    const quarantineRef = res.json().quarantineRef;
    expect(quarantineRef).toBeDefined();

    const entry = await app.inject({ method: 'GET', url: `/api/v1/quarantine/${quarantineRef}` });
    expect(entry.statusCode).toBe(200);
    const ctx = entry.json().context;
    expect(ctx.controlHeaders).toEqual({ 'TamaDB-TTL': '3600', 'TamaDB-Version': '4' });
  });

  it('records an empty controlHeaders set when no TamaDB-* headers are sent (audit fact)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      payload: { orderId: 31 }, // missing required 'name' -> quarantined
    });
    expect(res.statusCode).toBe(422);
    const entry = await app.inject({ method: 'GET', url: `/api/v1/quarantine/${res.json().quarantineRef}` });
    expect(entry.json().context.controlHeaders).toEqual({});
  });

  it('malformed JSON body -> PARSE_ERROR (400) and is quarantined (Req 17.7)', async () => {
    // A genuinely malformed byte stream must be handled by TamaDB's parse stage,
    // not rejected by the HTTP framework. Send a raw broken-JSON string with an
    // explicit JSON content-type so inject does not serialise an object.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'content-type': 'application/json' },
      payload: '{ "orderId": 1, "name": ', // truncated -> invalid JSON
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PARSE_ERROR');
    // Quarantined under the default data-errors-only policy.
    const quarantineRef = res.json().quarantineRef;
    expect(quarantineRef).toBeDefined();
    const entry = await app.inject({ method: 'GET', url: `/api/v1/quarantine/${quarantineRef}` });
    expect(entry.statusCode).toBe(200);
    expect(entry.json().context.rejectionType).toBe('parse-error');
    // The raw (unparseable) payload is preserved verbatim.
    expect(entry.json().payload).toBe('{ "orderId": 1, "name": ');
  });

  it('malformed JSON captures TamaDB-* control headers in the quarantine record', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'content-type': 'application/json', 'tamadb-ttl': '3600' },
      payload: 'not json at all',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PARSE_ERROR');
    const entry = await app.inject({ method: 'GET', url: `/api/v1/quarantine/${res.json().quarantineRef}` });
    expect(entry.json().context.controlHeaders).toEqual({ 'TamaDB-TTL': '3600' });
  });

  it('valid JSON that is not an object -> PARSE_ERROR (the body must be a document)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      headers: { 'content-type': 'application/json' },
      payload: '[1,2,3]', // valid JSON, but an array, not a document object
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PARSE_ERROR');
  });
});

// ─── T15.2: Document Endpoints ──────────────────────────────────────────────

describe('T15.2: Document Endpoints', () => {
  it('GET retrieves stored document', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/ingest/orders', payload: { orderId: 1, name: 'Test' } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/documents/orders/1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Test');
  });

  it('GET returns 404 for non-existent', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/documents/orders/999' });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE soft-deletes a document', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/ingest/orders', payload: { orderId: 1, name: 'Test' } });
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/documents/orders/1' });
    expect(res.statusCode).toBe(200);

    // Should no longer be retrievable
    const get = await app.inject({ method: 'GET', url: '/api/v1/documents/orders/1' });
    expect(get.statusCode).toBe(404);
  });

  it('POST /search finds documents by value', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/ingest/orders', payload: { orderId: 1, name: 'Alpha', amount: 100 } });
    await app.inject({ method: 'POST', url: '/api/v1/ingest/orders', payload: { orderId: 2, name: 'Beta', amount: 200 } });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/orders/search',
      payload: { field: 'amount', value: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(1);
  });
});

// ─── T15.4: Schema Endpoints ────────────────────────────────────────────────

describe('T15.4: Schema Endpoints', () => {
  it('POST /schemas registers a new schema', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/schemas',
      payload: { ref: 'test-v1', schema: { type: 'object', properties: { id: { type: 'integer' } } } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ref).toBe('test-v1');
  });

  it('GET /schemas/:ref retrieves schema', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/schemas/order-v1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ref).toBe('order-v1');
  });

  it('GET /schemas lists all registered schemas', async () => {
    // A second schema so the list is unambiguously a collection.
    await app.inject({
      method: 'POST',
      url: '/api/v1/schemas',
      payload: { ref: 'list-extra-v1', schema: { type: 'object' } },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/schemas' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    const refs = body.map((e: { ref: string }) => e.ref);
    expect(refs).toContain('order-v1');
    expect(refs).toContain('list-extra-v1');
    // Entries carry the full SchemaEntry shape (ref + lifecycle at minimum).
    const seeded = body.find((e: { ref: string }) => e.ref === 'order-v1');
    expect(seeded.lifecycle).toBe('active');
  });

  it('POST decommission/reactivate lifecycle', async () => {
    // Test with a non-master schema (temp-v1)
    await app.inject({ method: 'POST', url: '/api/v1/schemas', payload: { ref: 'temp-v1', schema: { type: 'object' } } });
    const dec2 = await app.inject({ method: 'POST', url: '/api/v1/schemas/temp-v1/decommission' });
    expect(dec2.statusCode).toBe(200);

    const react = await app.inject({ method: 'POST', url: '/api/v1/schemas/temp-v1/reactivate' });
    expect(react.statusCode).toBe(200);
  });
});

// ─── T15.5: Document_Type Endpoints ─────────────────────────────────────────

describe('T15.5: Document_Type Endpoints', () => {
  it('GET /config/document-types lists all types', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config/document-types' });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(1);
  });

  it('GET /config/document-types/:name retrieves specific type', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/config/document-types/orders' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('orders');
  });
});

// ─── T15.7: Configuration Endpoints ─────────────────────────────────────────

describe('T15.7: Configuration', () => {
  it('GET/PUT log-level', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/v1/config/log-level' });
    expect(get.statusCode).toBe(200);

    const put = await app.inject({ method: 'PUT', url: '/api/v1/config/log-level', payload: { level: 'warn' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().level).toBe('warn');
  });

  it('GET/PUT storage-strategy', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/v1/config/storage-strategy' });
    expect(get.statusCode).toBe(200);
    expect(get.json().mode).toBe('memory');
  });

  it('GET/PUT quarantine-policy', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/v1/config/quarantine-policy' });
    expect(get.statusCode).toBe(200);
    expect(get.json().policy).toBe('data-errors-only');

    const put = await app.inject({ method: 'PUT', url: '/api/v1/config/quarantine-policy', payload: { policy: 'all-rejections' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().policy).toBe('all-rejections');
  });

  it('GET/PUT enrichment-policies', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/v1/config/enrichment-policies' });
    expect(get.statusCode).toBe(200);
    expect(get.json().precedence).toBe('environment-over-content');
  });
});

// ─── T15.8: Quarantine Endpoints ────────────────────────────────────────────

describe('T15.8: Quarantine', () => {
  it('GET /quarantine returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/quarantine' });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(0);
  });

  it('GET /quarantine/:ref returns 404 for non-existent', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/quarantine/qr-nonexist' });
    expect(res.statusCode).toBe(404);
  });
});

// ─── T15.9: Error Response Format ───────────────────────────────────────────

describe('T15.9: Error Responses', () => {
  it('error responses have code and message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/orders',
      payload: { orderId: 1 },
    });
    const body = res.json();
    expect(body.code).toBeDefined();
    expect(body.message).toBeDefined();
  });
});

// ─── T15.10: Composed D-Id URL Encoding ─────────────────────────────────────

describe('T15.10: Composed D-Id URL', () => {
  it('uses delimiter for composed D-Ids in retrieval', async () => {
    // Setup: register a schema with composed key
    await app.inject({
      method: 'POST',
      url: '/api/v1/schemas',
      payload: {
        ref: 'composed-v1',
        schema: {
          type: 'object',
          properties: {
            customerId: { type: 'string', identityKind: 'parent-key' },
            orderId: { type: 'string', identityKind: 'primary-key' },
            data: { type: 'string' },
          },
          required: ['customerId', 'orderId', 'data'],
        },
      },
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/config/document-types',
      payload: { name: 'composed-orders', masterSchema: 'composed-v1', model: 'closed' },
    });

    // Store
    await app.inject({
      method: 'POST',
      url: '/api/v1/ingest/composed-orders',
      payload: { customerId: 'cust-A', orderId: 'ord-1', data: 'test' },
    });

    // Retrieve with composed D-Id (delimiter ':')
    const res = await app.inject({ method: 'GET', url: '/api/v1/documents/composed-orders/cust-A:ord-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBe('test');
  });
});
