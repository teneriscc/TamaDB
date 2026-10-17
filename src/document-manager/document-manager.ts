/**
 * Document Manager implementation (T8.1–T8.10)
 *
 * Orchestrates the full store pipeline: enrichment → D-Id extraction →
 * schema validation → merge/create → versioning. Also handles soft delete.
 *
 * Design reference: design.md § Document Manager
 * Validates: Requirements 1, 6, 7, 32, 33, 44
 */

import type { DocumentIdentifier, InternalDocument, SoftDeleteType, StorageAdapter, StoredBunch, StoredLeaf, Timestamp } from '../storage/types.js';
import type { ChannelResolution } from '../channel/types.js';
import type { EnrichmentEngine } from '../enrichment/types.js';
import type { DIdExtractor } from '../did/types.js';
import type { SchemaManager } from '../schema/types.js';
import type { DocumentTypeRegistry } from '../document-type/types.js';
import type { VersionManager } from '../version/types.js';
import type {
  DocumentManager,
  SoftDeleteResult,
  StoreHooks,
  StoreRequest,
  StoreResult,
  StoreWarning,
} from './types.js';

export interface DocumentManagerDeps {
  storage: StorageAdapter;
  schemaManager: SchemaManager;
  docTypeRegistry: DocumentTypeRegistry;
  enrichmentEngine: EnrichmentEngine;
  didExtractor: DIdExtractor;
  versionManager: VersionManager;
}

export class DocumentManagerImpl implements DocumentManager {
  private readonly deps: DocumentManagerDeps;
  private hooks: StoreHooks = {};

  constructor(deps: DocumentManagerDeps) {
    this.deps = deps;
  }

  setHooks(hooks: StoreHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  // ─── T8.1: Store Pipeline ──────────────────────────────────────────────

  store(request: StoreRequest, resolution: ChannelResolution): StoreResult {
    const { document: parsedPayload, versionNo: expectedVersion, ttl, expireAt } = request;
    const { documentType, channelId, applicableSchema } = resolution;

    // Step 4: Enrichment (T17.17)
    const enrichResult = this.deps.enrichmentEngine.enrich(
      parsedPayload,
      channelId ?? '__document_type_level__',
    );

    if (enrichResult.outcome === 'rejected') {
      this.hooks.onPayloadRejected?.(parsedPayload, 'ENRICHMENT_CONFLICT', { documentType, channelId: channelId ?? '' });
      return { success: false, code: 'ENRICHMENT_CONFLICT', message: 'Enrichment conflict with discard-and-error policy' };
    }

    const enrichedDocument = enrichResult.enrichedDocument;

    // Step 5: D-Id Extraction (T17.19 — operates on Enriched_Document)
    const docTypeConfig = this.deps.docTypeRegistry.get(documentType);
    if (!docTypeConfig) {
      return { success: false, code: 'DOCUMENT_TYPE_NOT_FOUND', message: `Document_Type '${documentType}' not found` };
    }

    const schemaEntry = this.deps.schemaManager.get(docTypeConfig.masterSchema);
    if (!schemaEntry) {
      return { success: false, code: 'SCHEMA_NOT_FOUND', message: `Master_Schema '${docTypeConfig.masterSchema}' not found` };
    }

    const defResult = this.deps.didExtractor.resolveDefinition(schemaEntry.schema, schemaEntry.dIdDefinition);
    if (!defResult.success) {
      return { success: false, code: defResult.code, message: defResult.message };
    }

    const extractResult = this.deps.didExtractor.extract(enrichedDocument, defResult.definition);
    if (!extractResult.success) {
      return { success: false, code: extractResult.code, message: extractResult.message };
    }

    const dId = extractResult.dId;

    // Step 6: Schema Validation (T17.18 — validates Enriched_Document)
    const validationResult = this.deps.schemaManager.validate(
      enrichedDocument,
      applicableSchema,
      docTypeConfig.model,
    );

    if (!validationResult.valid) {
      const errors = validationResult.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      this.hooks.onPayloadRejected?.(parsedPayload, 'SCHEMA_VALIDATION_FAILED', { documentType, dId, errors });
      return { success: false, code: 'SCHEMA_VALIDATION_FAILED', message: errors };
    }

    // Step 7-9: Optimistic concurrency check + Merge/Create
    const existing = this.deps.storage.retrieve(documentType, dId);

    if (existing) {
      // T7.9/T7.10: Concurrency check
      const concurrencyResult = this.deps.versionManager.checkConcurrency(existing.versionNo, expectedVersion);
      if (!concurrencyResult.success) {
        return { success: false, code: concurrencyResult.code, message: concurrencyResult.message };
      }

      // T8.2/T8.3: Merge into existing document
      const mergedDoc = this.mergeDocument(existing, enrichedDocument, resolution);
      this.deps.storage.store(documentType, dId, mergedDoc);

      // Trigger hooks
      this.hooks.onDocumentStored?.(documentType, dId, mergedDoc);

      // Build warning from enrichment conflicts
      const warning = this.buildWarning(enrichResult.conflicts.length > 0 ? enrichResult : undefined);

      return {
        success: true,
        dId,
        versionNo: mergedDoc.versionNo,
        created: false,
        ...(warning !== undefined ? { warning } : {}),
      };
    } else {
      // T8.3: Create new document
      const newDoc = this.createDocument(enrichedDocument, documentType, dId, docTypeConfig.model, resolution, ttl, expireAt);
      this.deps.storage.store(documentType, dId, newDoc);

      // Trigger hooks
      this.hooks.onDocumentStored?.(documentType, dId, newDoc);

      const warning = this.buildWarning(enrichResult.conflicts.length > 0 ? enrichResult : undefined);

      return {
        success: true,
        dId,
        versionNo: 1,
        created: true,
        ...(warning !== undefined ? { warning } : {}),
      };
    }
  }

  // ─── T8.5–T8.7: Soft Delete ───────────────────────────────────────────

  softDelete(documentType: string, dId: DocumentIdentifier, deleteType: SoftDeleteType): SoftDeleteResult {
    const existing = this.deps.storage.retrieve(documentType, dId);
    if (!existing) {
      return { success: false, code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' };
    }

    if (existing.softDeleted) {
      return { success: false, code: 'ALREADY_DELETED', message: 'Document is already soft-deleted' };
    }

    const timestamp = this.deps.versionManager.createTimestamp('__system__');
    const deletedDoc: InternalDocument = {
      ...existing,
      softDeleted: true,
      softDeleteType: deleteType,
      softDeleteTimestamp: this.deps.versionManager.finaliseTimestamp(timestamp),
    };

    this.deps.storage.store(documentType, dId, deletedDoc);
    return { success: true };
  }

  // ─── T8.8/T8.9: Document existence check ──────────────────────────────

  hasDocumentsOfType(documentType: string): boolean {
    const docs = this.deps.storage.listByDocumentType(documentType);
    return docs.length > 0;
  }

  // ─── Private: Create Document ──────────────────────────────────────────

  private createDocument(
    enrichedDocument: Record<string, unknown>,
    documentType: string,
    dId: DocumentIdentifier,
    model: string,
    resolution: ChannelResolution,
    ttl?: number | 'infinite',
    expireAt?: string,
  ): InternalDocument {
    const channelId = resolution.channelId ?? '__document_type_level__';
    const timestamp = this.deps.versionManager.createTimestamp(channelId);
    const timestampList: Timestamp[] = [];
    const tsRef = this.deps.versionManager.addTimestamp(timestampList, timestamp);
    this.finaliseLastTimestamp(timestampList, tsRef);

    // Convert enriched document to StoredBunch tree
    const root = this.buildStoredBunch(enrichedDocument, tsRef);

    // creationTime: the document's immutable creation instant, captured once
    // here from the first timestamp. As of 0.4.0 this is an audit field (and a
    // future ttlAnchor:'creation' seam), NOT the TTL anchor — TTL slides off the
    // last update time (Req 37.3b). On a freshly created document creationTime
    // and lastUpdateTime coincide (one timestamp); they diverge after the first
    // merge, which appends to timestampList but leaves creationTime unchanged.
    const creationTime = timestampList[0]?.requestTime ?? this.deps.versionManager.finaliseTimestamp(timestamp).requestTime;

    const doc: InternalDocument = {
      dId,
      documentType,
      creationTime,
      timestampList,
      versionNo: 1,
      historyDepth: 5, // Instance default (configurable in future)
      model: model as 'closed' | 'hybrid' | 'open',
      root,
      softDeleted: false,
      ...(ttl !== undefined ? { ttl } : {}),
      ...(expireAt !== undefined ? { expireAt } : {}),
    };

    return doc;
  }

  // ─── Private: Merge Document (T8.2) ────────────────────────────────────

  private mergeDocument(
    existing: InternalDocument,
    enrichedDocument: Record<string, unknown>,
    resolution: ChannelResolution,
  ): InternalDocument {
    const channelId = resolution.channelId ?? '__document_type_level__';
    const timestamp = this.deps.versionManager.createTimestamp(channelId);
    const timestampList = [...existing.timestampList];
    const tsRef = this.deps.versionManager.addTimestamp(timestampList, timestamp);
    this.finaliseLastTimestamp(timestampList, tsRef);

    // Merge: update present leaves, preserve absent leaves
    const mergedRoot = this.mergeBunch(existing.root, enrichedDocument, tsRef, existing.historyDepth);

    const doc: InternalDocument = {
      ...existing,
      timestampList,
      versionNo: existing.versionNo + 1,
      root: mergedRoot,
    };

    // Revival-on-update (Req 32.8b, 37.3b): a store targeting a document that
    // is currently TTL-driven soft-deleted AND salvageable REVIVES it — clear
    // the soft-delete state so the `...existing` spread above does not preserve
    // `softDeleted: true`. The onDocumentStored hook then re-arms the sliding
    // TTL window to lastUpdateTime + effectiveTTL. The document is revived, NOT
    // re-created: creationTime, history, and version lineage are preserved and
    // versionNo keeps incrementing.
    //
    // Salvageability (TTL-driven, effective TTL > 0, no Expire-at-Point-in-Time)
    // is judged against the EXISTING soft-deleted document via the injected
    // predicate — single-sourced in the TtlManager, the same classification the
    // read-path Best-Effort Read uses. Non-salvageable soft-deletes (explicit,
    // system_override, absolute_expired, and TTL=0 which is ttl_expired but not
    // salvageable) are permanent exclusions and are NOT revived by a store.
    if (
      existing.softDeleted &&
      existing.softDeleteType === 'ttl_expired' &&
      (this.hooks.isSalvageable?.(existing) ?? false)
    ) {
      // Rebuild without the soft-delete fields (they are optional on
      // InternalDocument, so omitting them clears the state) and set
      // softDeleted: false. Everything else — creationTime, root, history,
      // versionNo, ttl/expireAt — is preserved from `doc` above.
      const { softDeleteType: _removedType, softDeleteTimestamp: _removedTs, ...withoutSoftDelete } = doc;
      void _removedType;
      void _removedTs;
      return { ...withoutSoftDelete, softDeleted: false };
    }

    return doc;
  }

  /**
   * Merge incoming fields into an existing StoredBunch.
   * T8.2: Present leaves → update; absent leaves → unchanged; new valid leaves → create.
   * T8.4: Arrays treated as atomic leaves (full replacement).
   */
  private mergeBunch(
    existingBunch: StoredBunch,
    incoming: Record<string, unknown>,
    tsRef: { index: number },
    historyDepth: number,
  ): StoredBunch {
    const mergedChildren = new Map(existingBunch.children);

    for (const [key, value] of Object.entries(incoming)) {
      const existingChild = mergedChildren.get(key);

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        // Incoming is an object → should be a Bunch
        if (existingChild && 'children' in existingChild) {
          // Existing is a Bunch → recursive merge
          mergedChildren.set(
            key,
            this.mergeBunch(existingChild as StoredBunch, value as Record<string, unknown>, tsRef, historyDepth),
          );
        } else {
          // New bunch or replacing a leaf with a bunch
          mergedChildren.set(key, this.buildStoredBunch(value as Record<string, unknown>, tsRef));
        }
      } else {
        // Incoming is a leaf value (primitive, null, or array)
        if (existingChild && 'value' in existingChild) {
          // Update existing leaf
          const { updatedLeaf } = this.deps.versionManager.updateLeaf(
            existingChild as StoredLeaf,
            value,
            tsRef,
            historyDepth,
          );
          mergedChildren.set(key, updatedLeaf);
        } else {
          // New leaf
          mergedChildren.set(key, this.buildStoredLeaf(value, tsRef));
        }
      }
    }

    // Update bunch metadata
    const { updatedMetadata } = this.deps.versionManager.updateBunchMetadata(
      existingBunch.metadata,
      tsRef,
      historyDepth,
    );

    return { metadata: updatedMetadata, children: mergedChildren };
  }

  // ─── Private: Finalise the just-appended timestamp ─────────────────────

  /**
   * Fill `commitTime` (write-completion time, t1+m) on the timestamp just added
   * to `timestampList` at `tsRef.index`, in place. Without this the stored
   * entry keeps the empty `commitTime` that `createTimestamp` sets, because
   * `finaliseTimestamp` returns a NEW object that the store pipeline otherwise
   * discards (the 0.4.1 defect — `commitTime` is defined/documented and part of
   * the metadata-delivery surface, Req 39.3, but was always empty on stored
   * entries). `requestTime` and `channelIdentifier` are preserved.
   *
   * **Timing (Option B — see `docs/working-notes/defect-commit-timestamp-never-finalised.md`).**
   * We finalise here, between building the document and the SINGLE
   * `storage.store(...)` call — NOT after the write returns (Option A). This
   * keeps ingest to one store per document, which matters for a transmission
   * cache whose purpose is fast caching/forwarding; the trade-off is that
   * `commitTime` is "about to be written" (≈ `requestTime` + document build
   * time) rather than strictly "write completed". For an audit field with no
   * current consumer the sub-write-latency gap is immaterial; if a future
   * consumer needs true t1+m precision, revisit (Option A, double write).
   */
  private finaliseLastTimestamp(timestampList: Timestamp[], tsRef: { index: number }): void {
    const entry = timestampList[tsRef.index];
    if (entry) {
      timestampList[tsRef.index] = this.deps.versionManager.finaliseTimestamp(entry);
    }
  }

  // ─── Private: Build stored tree from raw values ────────────────────────

  private buildStoredBunch(obj: Record<string, unknown>, tsRef: { index: number }): StoredBunch {
    const children = new Map<string, StoredBunch | StoredLeaf>();

    for (const [key, value] of Object.entries(obj)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        children.set(key, this.buildStoredBunch(value as Record<string, unknown>, tsRef));
      } else {
        children.set(key, this.buildStoredLeaf(value, tsRef));
      }
    }

    const metadata = this.deps.versionManager.createBunchMetadata(tsRef);
    return { metadata, children };
  }

  private buildStoredLeaf(value: unknown, tsRef: { index: number }): StoredLeaf {
    return {
      value,
      metadata: this.deps.versionManager.createLeafMetadata(tsRef),
      history: [],
    };
  }

  // ─── Private: Warning builder ──────────────────────────────────────────

  private buildWarning(enrichResult?: { conflicts: readonly { fieldPath: string }[] }): StoreWarning | undefined {
    if (!enrichResult || enrichResult.conflicts.length === 0) return undefined;
    const fields = enrichResult.conflicts.map((c) => c.fieldPath).join(', ');
    return {
      code: 'ENRICHMENT_CONFLICT',
      message: `Enrichment conflicts resolved on fields: ${fields}`,
    };
  }
}
