/**
 * Regression tests for the 0.3.1 wiring-audit fixes.
 *
 * These wire the domain stack exactly as `src/index.ts` main() does — the
 * whole class of defect being fixed is "component logic exists and is
 * unit-tested, but is not connected in the production bootstrap". So these
 * tests assert the CONNECTED behaviour, not the components in isolation.
 *
 * Covers:
 *  - TTL enforcement on read paths (retrieve / glob / search) — Req 37b.4/6
 *  - Sliding-window expiry anchored to last update; a store re-arms, a read
 *    does not; revival-on-update (0.4.0) — Req 37.3b / 37b.5a / 32.8b
 *  - On-access Best-Effort Read of salvageable TTL-driven soft-deletes — Req 32.8
 *  - Background sweep soft-deletes without a prior read — Req 37b.1–2
 *  - Value-search includeExpired (default true, visibility-only) — Req 15.6–15.8
 *  - Document_Type deletion precondition — Req 46.12
 *  - Quarantine persisted at creation on the rejection (non-2xx) path — Req 17.7–9
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore } from '../src/storage/memory-store.js';
import { SchemaManagerImpl } from '../src/schema/schema-manager.js';
import { DocumentTypeRegistryImpl } from '../src/document-type/document-type-registry.js';
import { DIdExtractorImpl } from '../src/did/did-extractor.js';
import { VersionManagerImpl } from '../src/version/version-manager.js';
import { EnrichmentEngineImpl } from '../src/enrichment/enrichment-engine.js';
import { DocumentManagerImpl } from '../src/document-manager/document-manager.js';
import { QueryEngineImpl } from '../src/query/query-engine.js';
import { TtlManagerImpl } from '../src/ttl/ttl-manager.js';
import { QuarantineStoreImpl } from '../src/quarantine/quarantine-store.js';
import { PersistenceCoordinator } from '../src/persistence/persistence-coordinator.js';
import type { AppContext } from '../src/api/context.js';
import type { ChannelResolution } from '../src/channel/types.js';
import type { DocumentIdentifier, NotFoundReason } from '../src/storage/types.js';

// ─── Stack wired identically to main() ──────────────────────────────────────

function createWiredStack() {
  const storage = new MemoryStore();
  const schemaManager = new SchemaManagerImpl();
  const docTypeRegistry = new DocumentTypeRegistryImpl();
  const didExtractor = new DIdExtractorImpl();
  const versionManager = new VersionManagerImpl();
  const enrichmentEngine = new EnrichmentEngineImpl();
  const ttlManager = new TtlManagerImpl();
  const queryEngine = new QueryEngineImpl(storage);

  const documentManager = new DocumentManagerImpl({
    storage, schemaManager, docTypeRegistry, enrichmentEngine, didExtractor, versionManager,
  });

  // ── The wiring under test (mirrors src/index.ts) ──
  documentManager.setHooks({
    onDocumentStored: (documentType, dId, document) => {
      // Document-level TTL (most specific, Req 37.4) wins over type/instance.
      const effectiveTtl = document.ttl ?? ttlManager.getEffectiveTtl(documentType, dId);
      // Sliding-window anchor: most recent store = last timestampList entry (0.4.0).
      const lastUpdateTime =
        document.timestampList[document.timestampList.length - 1]?.requestTime ?? document.creationTime;
      ttlManager.registerExpiry(documentType, dId, lastUpdateTime, effectiveTtl, document.expireAt);
    },
    // Revival-on-update salvageability predicate (Req 32.8b), as in main().
    isSalvageable: (document) => {
      const result = ttlManager.checkOnAccess(document);
      return result.valid && result.action === 'serve';
    },
  });
  queryEngine.setTtlChecker((doc) => ttlManager.checkOnAccess(doc));
  queryEngine.setOnAccessPersist((documentType, dId, reason) => {
    const deleteType = reason === 'absolute-expired' ? 'absolute_expired' : 'ttl_expired';
    documentManager.softDelete(documentType, dId, deleteType);
    ttlManager.removeExpiry(documentType, dId);
  });
  docTypeRegistry.setDocumentExistenceChecker((dt) => documentManager.hasDocumentsOfType(dt));

  // The sweep body (as in main()'s runSweep), invoked explicitly in tests.
  const runSweep = (now?: string): void => {
    const expired = ttlManager.getExpiredEntries(now);
    for (const entry of expired) {
      const deleteType = entry.hasExpireAtPolicy ? 'absolute_expired' : 'ttl_expired';
      documentManager.softDelete(entry.documentType, entry.dId, deleteType);
      ttlManager.removeExpiry(entry.documentType, entry.dId);
    }
  };

  schemaManager.register({
    ref: 'test-v1',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', identityKind: 'primary-key' },
        name: { type: 'string' },
      },
      required: ['id', 'name'],
    },
  });
  docTypeRegistry.register({ name: 'items', masterSchema: 'test-v1', model: 'closed' });

  const resolution: ChannelResolution = { documentType: 'items', applicableSchema: 'test-v1', source: 'url' };
  const dIdOf = (v: string | number): DocumentIdentifier => ({ type: 'single', value: String(v) });

  /**
   * Store a document, then force its sliding-window anchor (the last
   * timestampList entry's requestTime — the 0.4.0 TTL anchor) into the past so
   * that TTL expiry is deterministic and clock-independent (both the sweep and
   * the real-clock on-access check agree it is expired). creationTime is aged
   * to the same instant for consistency (on a freshly created doc the two
   * coincide). Also re-anchors the expiry-table entry to match, mirroring what
   * registerExpiry would produce for a doc last stored at `pastIso`.
   */
  const storeAgedDoc = (
    body: Record<string, unknown>,
    pastIso: string,
    opts: { expireAt?: string; ttl?: number | 'infinite' } = {},
  ): DocumentIdentifier => {
    documentManager.store({
      document: body,
      ...(opts.expireAt ? { expireAt: opts.expireAt } : {}),
      ...(opts.ttl !== undefined ? { ttl: opts.ttl } : {}),
    }, resolution);
    const dId = dIdOf(body['id'] as number);
    const stored = storage.retrieve('items', dId)!;
    // Age the sliding anchor: rewrite every timestampList entry's requestTime to
    // the past so timestampList[last].requestTime (the 0.4.0 anchor) is aged.
    const agedTimestamps = stored.timestampList.map((t) => ({ ...t, requestTime: pastIso }));
    storage.store('items', dId, { ...stored, creationTime: pastIso, timestampList: agedTimestamps });
    // Re-register expiry from the aged last-update instant, honouring the TTL
    // hierarchy exactly as main()'s onDocumentStored hook does (document-level
    // TTL wins over type/instance).
    const effectiveTtl = stored.ttl ?? ttlManager.getEffectiveTtl('items', dId);
    ttlManager.registerExpiry('items', dId, pastIso, effectiveTtl, opts.expireAt);
    return dId;
  };

  return { storage, schemaManager, docTypeRegistry, documentManager, queryEngine, ttlManager, resolution, runSweep, dIdOf, storeAgedDoc };
}

function reasonOf(result: { success: boolean }): NotFoundReason | undefined {
  return (result as { reason?: NotFoundReason }).reason;
}

// ─── TTL enforcement on read paths (Gap: setTtlChecker never wired) ──────────

describe('TTL enforcement on read paths (Req 37b.4/37b.6)', () => {
  let stack: ReturnType<typeof createWiredStack>;
  beforeEach(() => { stack = createWiredStack(); });

  it('retrieve returns not-found for an Expire-At-expired document', () => {
    const { documentManager, queryEngine, resolution, dIdOf } = stack;
    // Expire-At already in the past.
    documentManager.store({ document: { id: 1, name: 'x' }, expireAt: '2000-01-01T00:00:00Z' }, resolution);

    const result = queryEngine.retrieveDocument('items', dIdOf(1));
    expect(result.success).toBe(false);
    expect(reasonOf(result)).toBe('absolute-expired');
  });

  it('glob excludes an expired document (inherits retrieveDocument)', () => {
    const { documentManager, queryEngine, resolution } = stack;
    documentManager.store({ document: { id: 1, name: 'live' }, ttl: 'infinite' }, resolution);
    documentManager.store({ document: { id: 2, name: 'dead' }, expireAt: '2000-01-01T00:00:00Z' }, resolution);

    const result = queryEngine.retrieveByGlob('items', { type: 'single', value: '*' });
    expect(result.success).toBe(true);
    const ids = result.documents.map((d) => (d.dId.type === 'single' ? d.dId.value : ''));
    expect(ids).toContain('1');
    expect(ids).not.toContain('2');
  });

  it('value search excludes a non-salvageable (Expire-At) expired document regardless of includeExpired', () => {
    const { documentManager, queryEngine, resolution } = stack;
    documentManager.store({ document: { id: 1, name: 'target' }, expireAt: '2000-01-01T00:00:00Z' }, resolution);

    const withFlag = queryEngine.searchByValue('items', 'name', 'target', true);
    const withoutFlag = queryEngine.searchByValue('items', 'name', 'target', false);
    expect(withFlag.matches).toHaveLength(0);
    expect(withoutFlag.matches).toHaveLength(0);
  });
});

// ─── Sliding-window expiry anchored to last update (Req 37.3b / 37b.5a) ──────
//
// 0.4.0 INVERTS the 0.3.1 creation-anchored behaviour: an update now DOES slide
// the expiry window forward. The test below is the inverse of the former
// "an update does NOT push the expiry instant forward" case.

describe('Sliding-window expiry anchored to last update (Req 37.3b/37b.5a)', () => {
  it('an update DOES push the expiry instant forward (window slides)', () => {
    const { documentManager, ttlManager, storage, resolution, dIdOf } = createWiredStack();
    ttlManager.configureTtl('document_type', 60, 'items'); // 60s TTL, no Expire-At → salvageable

    // Create at T0.
    documentManager.store({ document: { id: 1, name: 'v1' } }, resolution);
    const creationTime = storage.retrieve('items', dIdOf(1))!.creationTime;

    // Update at ~T0 (a moment later). The last timestampList entry's requestTime
    // is the sliding anchor; it advances to the update instant.
    documentManager.store({ document: { id: 1, name: 'v2' } }, resolution);
    const doc = storage.retrieve('items', dIdOf(1))!;
    const lastUpdate = doc.timestampList[doc.timestampList.length - 1]!.requestTime;

    // creationTime is still preserved as an audit field (not the anchor).
    expect(doc.creationTime).toBe(creationTime);

    // Evaluate 30s AFTER the last update: 30s < 60s TTL ⇒ still live (valid, no
    // action). Under the OLD creation-anchor model this same instant could have
    // been past creationTime + 60s and reported expired. Anchoring to the last
    // update keeps it live.
    const at30sAfterUpdate = new Date(new Date(lastUpdate).getTime() + 30_000).toISOString();
    const live = ttlManager.checkOnAccess(doc, at30sAfterUpdate);
    expect(live.valid).toBe(true);
    expect(live.action).toBeUndefined(); // live, not a Best-Effort 'serve'

    // Evaluate 90s after the last update: 90s > 60s TTL ⇒ expired-but-salvageable
    // ⇒ Best-Effort Read ('serve'). This proves the window is measured from the
    // last update, not from creation.
    const at90sAfterUpdate = new Date(new Date(lastUpdate).getTime() + 90_000).toISOString();
    const expired = ttlManager.checkOnAccess(doc, at90sAfterUpdate);
    expect(expired.valid).toBe(true);
    expect(expired.action).toBe('serve');
  });

  it('reads/searches do NOT re-arm: a hot-read-only doc still expires at lastUpdate + TTL', () => {
    const { queryEngine, ttlManager, storage, resolution, documentManager, dIdOf } = createWiredStack();
    ttlManager.configureTtl('document_type', 1, 'items'); // 1s TTL

    documentManager.store({ document: { id: 1, name: 'hot' } }, resolution);
    const dId = dIdOf(1);

    // Hammer the read path many times — a read must never advance the anchor.
    for (let i = 0; i < 10; i++) queryEngine.retrieveDocument('items', dId);

    const doc = storage.retrieve('items', dId)!;
    const lastUpdate = doc.timestampList[doc.timestampList.length - 1]!.requestTime;
    // 5s after the single store (never updated since) ⇒ past the 1s TTL ⇒ expired.
    const later = new Date(new Date(lastUpdate).getTime() + 5_000).toISOString();
    const check = ttlManager.checkOnAccess(doc, later);
    // Salvageable (TTL>0, no Expire-At) ⇒ 'serve', but crucially EXPIRED — reads
    // did not keep it live.
    expect(check.action).toBe('serve');
  });

  it('continuous updates ⇒ indefinite life (never expires while updated within the window)', () => {
    const { documentManager, ttlManager, storage, resolution, dIdOf } = createWiredStack();
    ttlManager.configureTtl('document_type', 60, 'items'); // 60s TTL

    const dId = dIdOf(1);
    let simulatedNow = new Date('2026-10-01T00:00:00Z').getTime();

    // Store once, then "update" every 30s (< 60s TTL) for 10 cycles, each time
    // aging the sliding anchor to the simulated store time and checking the doc
    // is live at that instant.
    documentManager.store({ document: { id: 1, name: 'v0' } }, resolution);
    for (let cycle = 1; cycle <= 10; cycle++) {
      simulatedNow += 30_000;
      const nowIso = new Date(simulatedNow).toISOString();
      // Age the sliding anchor to simulate a store at nowIso (the hook would
      // re-arm here in production; we age the last timestamp + re-register).
      const stored = storage.retrieve('items', dId)!;
      const aged = stored.timestampList.map((t, i) =>
        i === stored.timestampList.length - 1 ? { ...t, requestTime: nowIso } : t,
      );
      storage.store('items', dId, { ...stored, timestampList: aged });
      ttlManager.registerExpiry('items', dId, nowIso, 60);

      // At nowIso (the moment of this update) the doc is live.
      const doc = storage.retrieve('items', dId)!;
      const check = ttlManager.checkOnAccess(doc, nowIso);
      expect(check.valid).toBe(true);
      expect(check.action).toBeUndefined(); // live, never soft-deleted
    }
    // After 10 * 30s = 300s of continuous updates — far beyond the 60s TTL — the
    // document is still live because each update re-armed the window.
  });
});

// ─── Revival-on-update (Req 32.8b) ───────────────────────────────────────────

describe('Revival-on-update: a store revives a salvageable swept doc (Req 32.8b)', () => {
  it('an update to a swept-but-present salvageable doc clears soft-delete and re-arms', () => {
    const { documentManager, queryEngine, ttlManager, storage, resolution, runSweep, storeAgedDoc } = createWiredStack();
    ttlManager.configureTtl('document_type', 1, 'items'); // 1s TTL, salvageable

    const dId = storeAgedDoc({ id: 1, name: 'v1' }, '2026-09-01T00:00:00Z');
    const creationTime = storage.retrieve('items', dId)!.creationTime;
    const versionBefore = storage.retrieve('items', dId)!.versionNo;

    // Sweep → TTL-driven soft-delete.
    runSweep();
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(true);
    expect(storage.retrieve('items', dId)!.softDeleteType).toBe('ttl_expired');

    // Update (store) the swept doc → REVIVE.
    const result = documentManager.store({ document: { id: 1, name: 'v2' } }, resolution);
    expect(result.success).toBe(true);

    const revived = storage.retrieve('items', dId)!;
    expect(revived.softDeleted).toBe(false);                 // soft-delete cleared
    expect(revived.softDeleteType).toBeUndefined();          // state fully cleared
    expect(revived.softDeleteTimestamp).toBeUndefined();
    expect(revived.creationTime).toBe(creationTime);         // revived, NOT re-created
    expect(revived.versionNo).toBe(versionBefore + 1);       // lineage continues
    // The merged value is present (merge applied).
    const read = queryEngine.retrieveDocument('items', dId);
    expect(read.success).toBe(true);

    // The expiry table was re-armed (fresh window): a sweep NOW does not re-expire it.
    runSweep();
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(false);
  });

  it('does NOT revive a non-salvageable (Expire-At / absolute_expired) soft-deleted doc', () => {
    const { documentManager, ttlManager, storage, resolution, runSweep, storeAgedDoc } = createWiredStack();
    ttlManager.configureTtl('document_type', 60, 'items');

    // Aged doc WITH an Expire-At in the past → non-salvageable (absolute_expired).
    const dId = storeAgedDoc({ id: 1, name: 'v1' }, '2026-09-01T00:00:00Z', { expireAt: '2026-09-01T00:00:30Z' });
    runSweep();
    const swept = storage.retrieve('items', dId)!;
    expect(swept.softDeleted).toBe(true);
    expect(swept.softDeleteType).toBe('absolute_expired');

    // A store must NOT revive it (permanent exclusion).
    documentManager.store({ document: { id: 1, name: 'v2' }, expireAt: '2026-09-01T00:00:30Z' }, resolution);
    const after = storage.retrieve('items', dId)!;
    expect(after.softDeleted).toBe(true);
    expect(after.softDeleteType).toBe('absolute_expired');
  });

  it('does NOT revive an explicitly deleted doc', () => {
    const { documentManager, resolution, storage, dIdOf } = createWiredStack();
    documentManager.store({ document: { id: 1, name: 'v1' }, ttl: 'infinite' }, resolution);
    const dId = dIdOf(1);
    documentManager.softDelete('items', dId, 'explicit');
    expect(storage.retrieve('items', dId)!.softDeleteType).toBe('explicit');

    // A store must NOT revive an explicit soft-delete.
    documentManager.store({ document: { id: 1, name: 'v2' }, ttl: 'infinite' }, resolution);
    const after = storage.retrieve('items', dId)!;
    expect(after.softDeleted).toBe(true);
    expect(after.softDeleteType).toBe('explicit');
  });
});

// ─── On-access Best-Effort Read of salvageable TTL-driven soft-deletes ───────

describe('On-access Best-Effort Read (Req 32.8 / 32.8a)', () => {
  it('serves a swept salvageable doc in place WITHOUT clearing its soft-delete state or resetting TTL', () => {
    const { queryEngine, ttlManager, storage, runSweep, storeAgedDoc } = createWiredStack();
    ttlManager.configureTtl('document_type', 1, 'items'); // 1s TTL, salvageable (>0, no Expire-At)

    const dId = storeAgedDoc({ id: 1, name: 'x' }, '2026-09-01T00:00:00Z');
    const creationTime = storage.retrieve('items', dId)!.creationTime;

    // Sweep → soft-deletes it (no prior read).
    runSweep();
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(true);
    expect(storage.retrieve('items', dId)!.softDeleteType).toBe('ttl_expired');

    // Retrieve → served as a Best-Effort Read (last-chance read courtesy).
    const result = queryEngine.retrieveDocument('items', dId);
    expect(result.success).toBe(true);

    // Req 32.8a: visibility-only — NOT restored to the live set, soft-delete
    // state unchanged, TTL anchor untouched.
    const after = storage.retrieve('items', dId)!;
    expect(after.softDeleted).toBe(true);            // still soft-deleted (served in place)
    expect(after.softDeleteType).toBe('ttl_expired');
    expect(after.creationTime).toBe(creationTime);   // TTL anchor NOT reset
  });

  it('repeated Best-Effort Reads never restore the doc to live — it stays soft-deleted and sweep-eligible', () => {
    const { queryEngine, ttlManager, storage, runSweep, storeAgedDoc } = createWiredStack();
    ttlManager.configureTtl('document_type', 1, 'items');

    const dId = storeAgedDoc({ id: 1, name: 'x' }, '2026-09-01T00:00:00Z');
    runSweep();

    // Multiple reads all succeed (best-effort) but never flip it back to live.
    for (let i = 0; i < 3; i++) {
      expect(queryEngine.retrieveDocument('items', dId).success).toBe(true);
      expect(storage.retrieve('items', dId)!.softDeleted).toBe(true);
    }
    // A further sweep still finds it (it never left the soft-deleted state).
    runSweep();
    expect(storage.retrieve('items', dId)!.softDeleteType).toBe('ttl_expired');
  });

  it('does NOT serve a non-salvageable Expire-At soft-delete', () => {
    const { queryEngine, storage, runSweep, storeAgedDoc } = createWiredStack();
    const dId = storeAgedDoc({ id: 1, name: 'x' }, '2026-09-01T00:00:00Z', { expireAt: '2000-01-01T00:00:00Z' });

    runSweep();
    expect(storage.retrieve('items', dId)!.softDeleteType).toBe('absolute_expired');

    const result = queryEngine.retrieveDocument('items', dId);
    expect(result.success).toBe(false);
    expect(reasonOf(result)).toBe('absolute-expired');
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(true); // still deleted
  });

  it('serves a LIVE (not-yet-swept) salvageable expired doc in place, without soft-deleting it', () => {
    const { queryEngine, ttlManager, storage, storeAgedDoc } = createWiredStack();
    ttlManager.configureTtl('document_type', 1, 'items');
    const dId = storeAgedDoc({ id: 1, name: 'x' }, '2026-09-01T00:00:00Z');
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(false); // not swept

    const result = queryEngine.retrieveDocument('items', dId);
    expect(result.success).toBe(true);
    // Salvageable → served in place; the read does not persist a soft-delete.
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(false);
  });
});

// ─── Background sweep without a prior read (Req 37b.1–2) ──────────────────────

describe('Background sweep (Req 37b.1–2)', () => {
  it('soft-deletes an expired document without any prior retrieval', () => {
    const { storage, ttlManager, runSweep, storeAgedDoc } = createWiredStack();
    ttlManager.configureTtl('document_type', 1, 'items');
    const dId = storeAgedDoc({ id: 1, name: 'x' }, '2026-09-01T00:00:00Z');

    expect(storage.retrieve('items', dId)!.softDeleted).toBe(false);
    runSweep();
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(true);
    expect(storage.retrieve('items', dId)!.softDeleteType).toBe('ttl_expired');
  });
});

// ─── Document-level TTL governs expiry (Req 37.4 hierarchy) ──────────────────

describe('Document-level TTL wins over Document_Type/instance (Req 37.4)', () => {
  it('a short document-level TTL expires the doc even when the Document_Type TTL is infinite', () => {
    const { storage, ttlManager, runSweep, storeAgedDoc } = createWiredStack();
    // Document_Type TTL is infinite (would never expire), but the document
    // carries its own short TTL via the TamaDB-TTL header — the most specific
    // rung, which must win (Req 37.4).
    ttlManager.configureTtl('document_type', 'infinite', 'items');
    const dId = storeAgedDoc({ id: 1, name: 'x' }, '2026-09-01T00:00:00Z', { ttl: 1 });

    runSweep();
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(true);
    expect(storage.retrieve('items', dId)!.softDeleteType).toBe('ttl_expired');
  });

  it('a document-level infinite TTL survives even when the Document_Type TTL is short', () => {
    const { storage, ttlManager, runSweep, storeAgedDoc } = createWiredStack();
    // Document_Type TTL would expire it, but the document's own infinite TTL
    // (most specific) wins → it must NOT be swept.
    ttlManager.configureTtl('document_type', 1, 'items');
    const dId = storeAgedDoc({ id: 1, name: 'x' }, '2026-09-01T00:00:00Z', { ttl: 'infinite' });

    runSweep();
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(false);
  });
});

// ─── Value-search includeExpired (Req 15.6–15.8) ─────────────────────────────

describe('Value-search includeExpired (Req 15.6–15.8)', () => {
  it('default (true) surfaces a salvageable TTL-driven soft-delete; false hides it', () => {
    const { queryEngine, ttlManager, storage, runSweep, storeAgedDoc } = createWiredStack();
    ttlManager.configureTtl('document_type', 1, 'items'); // salvageable
    const dId = storeAgedDoc({ id: 1, name: 'findme' }, '2026-09-01T00:00:00Z');
    runSweep();
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(true);

    const included = queryEngine.searchByValue('items', 'name', 'findme', true);
    expect(included.matches).toHaveLength(1);

    const excluded = queryEngine.searchByValue('items', 'name', 'findme', false);
    expect(excluded.matches).toHaveLength(0);
  });

  it('applies the same visibility to a LIVE (not-yet-swept) salvageable expired doc (Req 37b.6)', () => {
    // No sweep here: the doc is expired-by-clock but still flagged live. Search
    // must still honour includeExpired via its own on-access guard.
    const { queryEngine, ttlManager, storage, storeAgedDoc } = createWiredStack();
    ttlManager.configureTtl('document_type', 1, 'items');
    const dId = storeAgedDoc({ id: 1, name: 'findme' }, '2026-09-01T00:00:00Z');
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(false); // not swept

    expect(queryEngine.searchByValue('items', 'name', 'findme', true).matches).toHaveLength(1);
    expect(queryEngine.searchByValue('items', 'name', 'findme', false).matches).toHaveLength(0);
  });

  it('surfacing is visibility-only: it does NOT persist a state change (doc stays soft-deleted)', () => {
    const { queryEngine, ttlManager, storage, runSweep, storeAgedDoc } = createWiredStack();
    ttlManager.configureTtl('document_type', 1, 'items');
    const dId = storeAgedDoc({ id: 1, name: 'findme' }, '2026-09-01T00:00:00Z');
    runSweep();

    queryEngine.searchByValue('items', 'name', 'findme', true); // surfaces it
    // Req 15.7: search must NOT reinstate/persist — unlike point lookup.
    expect(storage.retrieve('items', dId)!.softDeleted).toBe(true);
  });
});

// ─── Document_Type deletion precondition (Req 46.12) ─────────────────────────

describe('Document_Type deletion precondition (Req 46.12)', () => {
  it('rejects deletion while documents of that type exist', () => {
    const { documentManager, docTypeRegistry, resolution } = createWiredStack();
    documentManager.store({ document: { id: 1, name: 'x' } }, resolution);

    const result = docTypeRegistry.delete('items');
    expect(result.success).toBe(false);
    expect(result.code).toBe('DOCUMENTS_EXIST');
  });

  it('rejects deletion when only a soft-deleted document of that type exists (Req 46.12 "including soft-deleted")', () => {
    const { documentManager, docTypeRegistry, resolution, dIdOf } = createWiredStack();
    documentManager.store({ document: { id: 1, name: 'x' } }, resolution);
    documentManager.softDelete('items', dIdOf(1), 'explicit');

    const result = docTypeRegistry.delete('items');
    expect(result.success).toBe(false);
    expect(result.code).toBe('DOCUMENTS_EXIST');
  });
});


// ─── Quarantine persisted at creation on the rejection path (Req 17.7–9) ─────

describe('Quarantine persistence on the rejection (non-2xx) path', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tamadb-quar-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes a rejection-created entry to disk WITHOUT any intervening 2xx mutation', () => {
    const quarantineStore = new QuarantineStoreImpl();
    const coordinator = new PersistenceCoordinator(dataDir);
    // Minimal ctx: the coordinator only needs quarantineStore for saveQuarantine.
    coordinator.setContext({ quarantineStore } as unknown as AppContext);

    // Wire the persist hook exactly as main() does.
    quarantineStore.setPersistHook(() => coordinator.saveQuarantine());

    // Create a quarantine entry via a rejection (all-rejections policy so the
    // parse-error is captured). No saveAll()/2xx mutation is triggered.
    quarantineStore.setPolicy('all-rejections');
    const ref = quarantineStore.quarantine('not json', {
      receivedAt: '2026-09-01T00:00:00Z',
      sourceIdentifier: 'test',
      rejectionReason: 'malformed body',
      rejectionType: 'parse-error',
      controlHeaders: { 'TamaDB-Version': '3' },
    });
    expect(ref).toBeDefined();

    // The on-disk snapshot must already contain the entry.
    const file = join(dataDir, 'quarantine.json');
    expect(existsSync(file)).toBe(true);
    const snapshot = JSON.parse(readFileSync(file, 'utf-8')) as { entries: Array<{ ref: string; context: { controlHeaders: Record<string, string> } }> };
    expect(snapshot.entries.map((e) => e.ref)).toContain(ref);
    // Verbatim Control_Header audit capture is persisted too (Req 17.9).
    const persisted = snapshot.entries.find((e) => e.ref === ref)!;
    expect(persisted.context.controlHeaders['TamaDB-Version']).toBe('3');
  });
});
