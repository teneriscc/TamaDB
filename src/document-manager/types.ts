/**
 * Document Manager types (T8.1–T8.10)
 *
 * Defines the store pipeline, merge logic, soft delete, and the
 * DocumentManager interface.
 *
 * Design reference: design.md § Document Manager
 * Validates: Requirements 1, 6, 7, 32, 33, 44
 */

import type { DocumentIdentifier, InternalDocument, SoftDeleteType } from '../storage/types.js';
import type { ChannelResolution } from '../channel/types.js';

// ─── Store Request & Result ─────────────────────────────────────────────────

export interface StoreRequest {
  /** The parsed JSON payload (Parsed_Payload). */
  readonly document: Record<string, unknown>;
  /** Optional version for optimistic concurrency. Undefined = blind write. */
  readonly versionNo?: number;
  /** Optional document-level TTL. */
  readonly ttl?: number | 'infinite';
  /** Optional Expire-at-Point-in-Time. */
  readonly expireAt?: string;
}

export interface StoreSuccess {
  readonly success: true;
  readonly dId: DocumentIdentifier;
  readonly versionNo: number;
  readonly created: boolean;
  readonly warning?: StoreWarning;
}

export interface StoreError {
  readonly success: false;
  readonly code: string;
  readonly message: string;
}

export type StoreResult = StoreSuccess | StoreError;

export interface StoreWarning {
  readonly code: string;
  readonly message: string;
}

// ─── Soft Delete ────────────────────────────────────────────────────────────

export interface SoftDeleteResult {
  readonly success: boolean;
  readonly code?: string;
  readonly message?: string;
}

// ─── Store Pipeline Hooks (for components not yet built) ────────────────────

export interface StoreHooks {
  /**
   * Called after a successful store to trigger downstream integration (TTL
   * arming, subscription fan-out). `writtenPaths` is the set of leaf/bunch
   * paths actually written by THIS operation, in dot notation (e.g.
   * `temperature`, `location.room`), enabling node-scoped subscription
   * triggering (Req 38.1a). It is a **presence-in-write** set — content-agnostic
   * per Req 38.1 / Design Principle 7: a path appears because the operation wrote
   * it, regardless of whether its value changed. On create it is every path in
   * the stored document; on merge it is the paths present in the incoming
   * (enriched) payload. The empty-string path `''` denotes the document root,
   * included so that path-less (whole-document / D-Id / Document_Type)
   * subscriptions always see a trigger.
   */
  onDocumentStored?: (
    documentType: string,
    dId: DocumentIdentifier,
    document: InternalDocument,
    writtenPaths: string[],
  ) => void;
  /** Called to quarantine a rejected payload (C11). */
  onPayloadRejected?: (payload: unknown, reason: string, context: Record<string, unknown>) => void;
  /**
   * Revival-on-update salvageability predicate (Req 32.8b). Returns true when a
   * currently-soft-deleted document is TTL-driven salvageable — effective TTL
   * (resolved via the TTL hierarchy, Req 37.4) > 0 AND no Expire-at-Point-in-Time
   * policy. Wired to the TtlManager so the salvageability rule is single-sourced
   * (same classification used by the read-path Best-Effort Read). When this hook
   * is absent, the merge pipeline does NOT revive (conservative default).
   */
  isSalvageable?: (document: InternalDocument) => boolean;
}

// ─── Document Manager Interface ─────────────────────────────────────────────

export interface DocumentManager {
  /**
   * Execute the store pipeline (T8.1):
   * Enrichment → D-Id extraction → Validation → Merge/Create → Version.
   */
  store(request: StoreRequest, resolution: ChannelResolution): StoreResult;

  /**
   * Soft-delete a document (T8.5–T8.7).
   */
  softDelete(documentType: string, dId: DocumentIdentifier, deleteType: SoftDeleteType): SoftDeleteResult;

  /**
   * Check if any documents exist for a Document_Type (T4.4 support).
   */
  hasDocumentsOfType(documentType: string): boolean;

  /**
   * Set pipeline hooks for downstream integration.
   */
  setHooks(hooks: StoreHooks): void;
}
