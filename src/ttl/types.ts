/**
 * TTL Manager types (T10.1–T10.12)
 *
 * Defines TTL configuration, expiry table, and the TtlManager interface.
 *
 * Design reference: design.md § TTL Manager
 * Validates: Requirements 37, 37b
 */

import type { DocumentIdentifier, InternalDocument } from '../storage/types.js';

// ─── TTL Scope & Configuration ──────────────────────────────────────────────

export type TtlScope = 'instance' | 'document_type' | 'document';
export type Duration = number | 'infinite';

export interface TtlConfig {
  readonly scope: TtlScope;
  readonly target?: string; // Document_Type name or serialised D-Id
  readonly duration: Duration;
}

// ─── Expiry Table Entry ─────────────────────────────────────────────────────

export interface ExpiryEntry {
  readonly documentType: string;
  readonly dId: DocumentIdentifier;
  /** Absolute expiry time (ISO string). */
  readonly expiresAt: string;
  /** Whether this document has Expire-at-Point-in-Time set. */
  readonly hasExpireAtPolicy: boolean;
}

// ─── Sweep Report ───────────────────────────────────────────────────────────

export interface ExpiryReport {
  readonly swept: number;
  readonly errors: number;
  readonly timestamp: string;
}

// ─── TTL Check Result (for on-access) ───────────────────────────────────────

export interface TtlCheckResult {
  /** Whether the document may still be served (live, or a salvageable Best-Effort Read). */
  readonly valid: boolean;
  /**
   * If expired: `'serve'` = salvageable, serve as a Best-Effort Read in place
   * (no state change); `'soft-delete'` = non-salvageable, soft-delete and
   * return not-found. There is no reinstatement/flip-to-live action.
   */
  readonly action?: 'serve' | 'soft-delete';
  /** Not-found reason for the caller (non-salvageable case). */
  readonly reason?: 'ttl-expired' | 'absolute-expired';
}

// ─── TTL Floor Warning ──────────────────────────────────────────────────────

export interface TtlFloorWarning {
  readonly code: 'TTL_FLOOR_ADJUSTED';
  readonly requestedTtl: number;
  readonly appliedTtl: number;
  readonly floor: number;
}

// ─── TTL Manager Interface ──────────────────────────────────────────────────

export interface TtlManager {
  /**
   * Configure TTL at a given scope (T10.1).
   */
  configureTtl(scope: TtlScope, duration: Duration, target?: string): TtlFloorWarning | undefined;

  /**
   * Get the effective TTL for a document (T10.2).
   * Hierarchy: document > Document_Type > instance.
   */
  getEffectiveTtl(documentType: string, dId: DocumentIdentifier): Duration;

  /**
   * Register a document in the expiry table (T10.3, T10.12).
   */
  registerExpiry(documentType: string, dId: DocumentIdentifier, storeTimestamp: string, effectiveTtl: Duration, expireAt?: string): void;

  /**
   * Remove a document from the expiry table (on soft-delete or physical removal).
   */
  removeExpiry(documentType: string, dId: DocumentIdentifier): void;

  /**
   * Run one sweep cycle (T10.4).
   * Returns report of how many documents were expired.
   */
  sweep(now?: string): ExpiryReport;

  /**
   * On-access TTL check (T10.5, T10.10).
   * Determines if the document is expired and, if so, whether it is salvageable
   * (serve as a Best-Effort Read) or must be soft-deleted and reported not-found.
   */
  checkOnAccess(doc: InternalDocument, now?: string): TtlCheckResult;

  /**
   * Get the calculated minimum TTL floor (T10.7, T10.8).
   */
  getMinimumTtlFloor(): number;

  /**
   * Get/set sweep interval in milliseconds.
   */
  getSweepInterval(): number;
  setSweepInterval(ms: number): void;

  /**
   * Get instance-level TTL.
   */
  getInstanceTtl(): Duration;
}
