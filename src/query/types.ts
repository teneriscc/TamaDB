/**
 * Query Engine types (T9.1–T9.12)
 *
 * Defines retrieval, search, and filtering interfaces.
 *
 * Design reference: design.md § Query Engine
 * Validates: Requirements 8, 9, 10, 11, 13, 14, 15
 */

import type { DocumentIdentifier, InternalDocument } from '../storage/types.js';

// ─── Retrieval Modes ────────────────────────────────────────────────────────

export type RetrievalMode = 'closed' | 'open' | 'full';

// ─── Retrieval Options ──────────────────────────────────────────────────────

export interface RetrievalOptions {
  /** Dot-notation path for leaf/bunch retrieval. */
  readonly path?: string;
  /** Retrieval_Schema for output filtering. */
  readonly retrievalSchema?: Record<string, unknown>;
  /** Retrieval mode. Default: 'full'. */
  readonly mode?: RetrievalMode;
  /** Point-in-time timestamp index for leaf retrieval. */
  readonly timestampIndex?: number;
}

// ─── Query Results ──────────────────────────────────────────────────────────

export interface RetrievalSuccess {
  readonly success: true;
  readonly document: Record<string, unknown>;
  readonly dId: DocumentIdentifier;
  readonly documentType: string;
}

export interface RetrievalError {
  readonly success: false;
  readonly code: string;
  readonly message: string;
  /** Reason for not-found (T9.12). */
  readonly reason?: NotFoundReason;
}

export type RetrievalResult = RetrievalSuccess | RetrievalError;

export type NotFoundReason =
  | 'explicit-soft-deleted'
  | 'ttl-expired'
  | 'absolute-expired'
  | 'system-override'
  | null;

export interface MultiRetrievalResult {
  readonly success: true;
  readonly documents: readonly RetrievalSuccess[];
}

export interface SearchResult {
  readonly success: true;
  readonly matches: readonly RetrievalSuccess[];
}

// ─── TTL Check Hook ─────────────────────────────────────────────────────────

export interface TtlCheckResult {
  /** Whether the document may still be served (live, or salvageable Best-Effort Read). */
  readonly valid: boolean;
  /**
   * If expired: `'serve'` = salvageable, serve in place as a Best-Effort Read
   * (no state change); `'soft-delete'` = non-salvageable, soft-delete and
   * return not-found. There is no reinstatement/flip-to-live action.
   */
  readonly action?: 'serve' | 'soft-delete';
  readonly reason?: NotFoundReason;
}

/**
 * Hook for TTL check (C10 integration).
 * Called before returning any document to check expiry.
 */
export type TtlChecker = (doc: InternalDocument) => TtlCheckResult;

/**
 * Persist a NON-salvageable on-access expiry (C8/C10 integration): when an
 * on-access check finds a live document past a non-salvageable expiry
 * (Expire-at-Point-in-Time, or TTL=0), perform the TTL-driven soft-delete now
 * (on-access safety net, Req 37b.4/37b.6) so the persisted state matches the
 * not-found result returned to the caller.
 *
 * Note (Best-Effort Read model): a salvageable expired document is served in
 * place with NO persistence — there is no reinstatement, so this hook is never
 * invoked for the salvageable case.
 */
export type OnAccessPersist = (
  documentType: string,
  dId: DocumentIdentifier,
  reason?: NotFoundReason,
) => void;

// ─── Query Engine Interface ─────────────────────────────────────────────────

export interface QueryEngine {
  /**
   * Retrieve a single document by exact D-Id (T9.1).
   */
  retrieveDocument(documentType: string, dId: DocumentIdentifier, options?: RetrievalOptions): RetrievalResult;

  /**
   * Retrieve documents matching a glob pattern (T9.2).
   */
  retrieveByGlob(documentType: string, pattern: DocumentIdentifier): MultiRetrievalResult;

  /**
   * Retrieve a leaf by D-Id + dot-notation path (T9.3).
   */
  retrieveLeaf(documentType: string, dId: DocumentIdentifier, path: string): RetrievalResult;

  /**
   * Retrieve a bunch by D-Id + dot-notation path (T9.4).
   */
  retrieveBunch(documentType: string, dId: DocumentIdentifier, path: string): RetrievalResult;

  /**
   * Search documents by leaf value (T9.8).
   *
   * `includeExpired` (default true) controls whether TTL-driven salvageable
   * soft-deletes are surfaced as Best-Effort Reads, consistent with point-lookup
   * retrieval (Req 15.6–15.8). Surfacing is visibility-only: it never alters the
   * TTL clock nor persists a soft-delete-state change.
   */
  searchByValue(documentType: string, fieldPath: string, value: unknown, includeExpired?: boolean): SearchResult;

  /**
   * Set the TTL checker hook (C10 integration).
   */
  setTtlChecker(checker: TtlChecker): void;

  /**
   * Set the on-access persistence hook (Req 37b.4). Used by the point-lookup
   * path to persist a NON-salvageable TTL-driven soft-delete decided by the
   * on-access check. (Salvageable docs are served in place with no persistence.)
   */
  setOnAccessPersist(persist: OnAccessPersist): void;
}
