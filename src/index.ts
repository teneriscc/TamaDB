import { loadConfig } from './config.js';
import { createLogger } from './logging/logger.js';
import { buildServer } from './server.js';
import { registerAllRoutes } from './api/index.js';
import type { AppContext } from './api/context.js';
import { StorageManager } from './storage/index.js';
import { SchemaManagerImpl } from './schema/index.js';
import { DocumentTypeRegistryImpl } from './document-type/index.js';
import { ChannelResolverImpl } from './channel/index.js';
import { DIdExtractorImpl } from './did/index.js';
import { VersionManagerImpl } from './version/index.js';
import { EnrichmentEngineImpl } from './enrichment/index.js';
import { DocumentManagerImpl } from './document-manager/index.js';
import { QueryEngineImpl } from './query/index.js';
import { TtlManagerImpl } from './ttl/index.js';
import { QuarantineStoreImpl } from './quarantine/index.js';
import { SubscriptionManagerImpl } from './subscription/index.js';
import { WebhookDispatcherImpl, createHttpDeliveryFn, enqueueSubscriptionJobs } from './webhook/index.js';
import { PersistenceCoordinator } from './persistence/persistence-coordinator.js';

/**
 * Process entrypoint: load config, initialise logging, wire up domain
 * components, register API routes, and start the HTTP server.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const app = await buildServer(config);

  // Composed-D-Id delimiter (Req 34.9). One constant for the API context AND the
  // TamaDB-D-Id webhook header, so the two can never disagree.
  const dIdDelimiter = ':';

  // ─── Instantiate domain components ────────────────────────────────────

  const storageManager = new StorageManager({ mode: config.storageMode });
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

  // Wire cross-component dependencies
  schemaManager.setMasterSchemaChecker((ref) => docTypeRegistry.isMasterSchema(ref));

  // Channel view reflects the Enrichment Engine's real bindings (read-through;
  // engine remains the source of truth) instead of a hardcoded empty array.
  channelResolver.setEnrichmentBindingsProvider((channelId) => enrichmentEngine.getBindings(channelId));

  // ─── TTL enforcement wiring (Req 37, 37b) ─────────────────────────────
  //
  // Register expiry on store so the expiry table and background sweep have
  // data. TTL is a SLIDING WINDOW anchored to the document's LAST UPDATE time
  // (Req 37.3b): every store re-arms it. Because this hook fires on every store
  // (create or merge), passing the most-recent store timestamp here slides the
  // window forward automatically. (creationTime is retained on the document for
  // audit and a future ttlAnchor: 'update' | 'creation' mode, but is no longer
  // the TTL anchor — see requirements Req 37.3b Future Considerations.)
  documentManager.setHooks({
    onDocumentStored: (documentType, dId, document, writtenPaths) => {
      // Honour the TTL hierarchy (Req 37.4): the document-level TTL (from the
      // TamaDB-TTL header, stored on the document) is the most specific rung and
      // wins over Document_Type/instance TTL. getEffectiveTtl only consults the
      // configured type/instance maps, so fall back to it only when the document
      // carries no own TTL.
      const effectiveTtl = document.ttl ?? ttlManager.getEffectiveTtl(documentType, dId);
      // Sliding-window anchor: the request time of the most recent store (the
      // last timestampList entry). Falls back to creationTime only if the list
      // is somehow empty (defensive — createDocument always appends one entry).
      const lastUpdateTime =
        document.timestampList[document.timestampList.length - 1]?.requestTime ?? document.creationTime;
      ttlManager.registerExpiry(documentType, dId, lastUpdateTime, effectiveTtl, document.expireAt);

      // ─── Subscription → webhook fan-out (Req 35, 38) ───────────────────
      //
      // Node-scoped triggering (Req 38.1a): createWebhookJobs filters the
      // matching subscriptions by `writtenPaths` — a presence-in-write set,
      // content-agnostic (Req 38.1). Snapshot-at-enqueue (Req 35.11): the
      // payload is formatted NOW and captured into the dispatcher queue,
      // decoupled from the document's later TTL/store lifecycle. This fan-out
      // runs synchronously inside the store pipeline, so a TTL=0 document
      // (Req 37.5b) enqueues its deliveries BEFORE its immediate post-store
      // soft-delete. Projecting the document to a plain object for formatting
      // reuses the query engine's retrieval projection (schema + metadata
      // stripped), matching what a pull would return.
      const projected = queryEngine.renderStoredDocument(document);
      const jobs = subscriptionManager.createWebhookJobs(projected, documentType, dId, writtenPaths);
      // The job mapping (payload + TamaDB-* delivery-context headers + the
      // Expire-At hard-cutoff carry-over) lives in enqueueSubscriptionJobs so
      // production and the pipeline tests run the same code.
      enqueueSubscriptionJobs(webhookDispatcher, jobs, {
        expireAt: document.expireAt,
        dIdDelimiter,
      });
    },
    // Revival-on-update salvageability predicate (Req 32.8b): a merge targeting
    // a TTL-driven soft-deleted document revives it only if it is still
    // salvageable. Single-source the rule in the TtlManager — checkOnAccess
    // returns { valid, action: 'serve' } exactly for a salvageable expired doc
    // (effective TTL > 0, no Expire-at-Point-in-Time), matching the read-path
    // Best-Effort Read classification.
    isSalvageable: (document) => {
      const result = ttlManager.checkOnAccess(document);
      return result.valid && result.action === 'serve';
    },
  });

  // ─── Webhook delivery wiring (Req 35.2, 35.7, 35.9) ───────────────────
  //
  // Real HTTP delivery via the built-in fetch client, and the instance-level
  // retry ceiling for `retry`-mode subscriptions (Req 35.9). Without these the
  // dispatcher falls back to an always-failing stub and the code default of 5.
  webhookDispatcher.setDeliveryFn(createHttpDeliveryFn());
  webhookDispatcher.setMaxRetries(config.webhookMaxRetries);

  // On-access TTL check for retrieval/glob (Req 37b.4). The QueryEngine calls
  // this before serving; checkOnAccess evaluates against the sliding,
  // update-anchored expiry instant (Req 37b.5a). A read never re-arms the
  // window — only a store does.
  queryEngine.setTtlChecker((doc) => ttlManager.checkOnAccess(doc));

  // Persist a NON-salvageable on-access expiry (Req 37b.4): a live document
  // found past a non-salvageable expiry (Expire-At, or TTL=0) is soft-deleted
  // now so persisted state matches the not-found result. Salvageable expired
  // documents are served in place as a Best-Effort Read with no persistence
  // (Req 32.8/32.8a), so this hook is not invoked for them.
  queryEngine.setOnAccessPersist((documentType, dId, reason) => {
    const deleteType = reason === 'absolute-expired' ? 'absolute_expired' : 'ttl_expired';
    documentManager.softDelete(documentType, dId, deleteType);
    ttlManager.removeExpiry(documentType, dId);
  });

  // Document_Type deletion precondition (Req 46.12): reject deletion while
  // documents of that type still exist (including soft-deleted).
  docTypeRegistry.setDocumentExistenceChecker((documentType) => documentManager.hasDocumentsOfType(documentType));

  // ─── Persistence Coordinator ──────────────────────────────────────────

  const persistenceCoordinator = config.storageMode !== 'memory'
    ? new PersistenceCoordinator()
    : undefined;

  // ─── Build AppContext and register routes ─────────────────────────────

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
    dIdDelimiter,
    persistence: persistenceCoordinator,
  };

  // ─── Restore persisted state (unless pure memory mode) ────────────────

  if (persistenceCoordinator) {
    persistenceCoordinator.setContext(ctx);
    const { restored, components } = persistenceCoordinator.restoreAll();
    if (restored) {
      logger.info({ components }, 'State restored from disk');
    }

    // Persist quarantine at creation time (audit durability). Rejections return
    // non-2xx, so the 2xx-only write-through hook below does not cover them;
    // this saves the quarantine snapshot the moment an entry is created.
    quarantineStore.setPersistHook(() => persistenceCoordinator.saveQuarantine());
  }

  registerAllRoutes(app, ctx);

  // ─── Background TTL sweep (Req 37b.1–2) ───────────────────────────────
  //
  // Periodically soft-delete documents whose sliding, update-anchored expiry
  // instant has passed. The on-access check (above) is the safety net between
  // sweeps (Req 37b.4/37b.6). getExpiredEntries reads the expiry-table entry,
  // which holds the slid value re-armed by the most recent store (Req 37b.5a).
  const runSweep = (): void => {
    const expired = ttlManager.getExpiredEntries();
    for (const entry of expired) {
      const deleteType = entry.hasExpireAtPolicy ? 'absolute_expired' : 'ttl_expired';
      documentManager.softDelete(entry.documentType, entry.dId, deleteType);
      ttlManager.removeExpiry(entry.documentType, entry.dId);
    }
  };
  const sweepTimer = setInterval(runSweep, ttlManager.getSweepInterval());
  // Do not keep the process alive solely for the sweep (Req 37b.7: non-blocking).
  sweepTimer.unref?.();

  // ─── Webhook delivery pump (Req 35.2–35.9) ────────────────────────────
  //
  // Drains the dispatcher queue: each tick calls processNext until no job is
  // ready (an exhausted-or-delivered job is removed, a retryable failure is
  // rescheduled with backoff and skipped until its nextAttemptAt). Mirrors the
  // TTL sweep: unref'd so it never keeps the process alive, cleared on shutdown.
  // A re-entrancy guard prevents overlapping drains if a tick's async deliveries
  // outlast the interval. Pickup latency is bounded by the interval; a
  // store-triggered immediate drain is deferred (see the 0.6.0 design note).
  let draining = false;
  const runPump = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      // Drain all currently-ready jobs. processNext returns undefined when none
      // is ready (queue empty, or remaining jobs are waiting on backoff).
      while (await webhookDispatcher.processNext()) {
        // keep draining
      }
    } catch (err) {
      logger.error({ err }, 'Webhook pump error');
    } finally {
      draining = false;
    }
  };
  const pumpTimer = setInterval(() => void runPump(), config.webhookPumpIntervalMs);
  pumpTimer.unref?.();

  // ─── Write-through persistence hook ───────────────────────────────────

  if (persistenceCoordinator) {
    app.addHook('onResponse', async (request, reply) => {
      // Persist config state after successful mutations (POST/PUT/DELETE)
      // Documents are handled by the storage strategy (disk/auto/hybrid write directly)
      const method = request.method;
      const status = reply.statusCode;
      if ((method === 'POST' || method === 'PUT' || method === 'DELETE') && status >= 200 && status < 300) {
        persistenceCoordinator.saveAll();
      }
    });
  }

  // ─── Admin: Graceful Shutdown Endpoint ──────────────────────────────────

  app.post('/api/v1/admin/shutdown', async (_request, reply) => {
    logger.info('Shutdown requested via API');
    // Send response before shutting down
    await reply.status(200).send({ status: 'shutting-down' });

    // Perform graceful shutdown asynchronously after response is sent
    setImmediate(async () => {
      clearInterval(sweepTimer);
      clearInterval(pumpTimer);
      const drained = storageManager.drain();
      if (drained > 0) {
        logger.info({ documentsWritten: drained }, 'Memory drained to disk');
      }
      if (persistenceCoordinator) {
        persistenceCoordinator.saveAll();
        logger.info('State persisted to disk');
      }
      await app.close();
      process.exit(0);
    });
  });

  // ─── Start listening ──────────────────────────────────────────────────

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port, host: config.host, storageMode: config.storageMode }, 'TamaDB started');
  } catch (err) {
    logger.error({ err }, 'Failed to start TamaDB');
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    clearInterval(sweepTimer);
    clearInterval(pumpTimer);
    const drained = storageManager.drain();
    if (drained > 0) {
      logger.info({ documentsWritten: drained }, 'Memory drained to disk');
    }
    if (persistenceCoordinator) {
      persistenceCoordinator.saveAll();
      logger.info('State persisted to disk');
    }
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
