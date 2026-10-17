/**
 * Version Manager types (T7.1–T7.12)
 *
 * Defines versioning, timestamp, history management types and the
 * VersionManager interface.
 *
 * Design reference: design.md § Version Manager
 * Validates: Requirements 2, 3, 4, 23, 33
 */

import type { Timestamp, TimestampReference, HistoryEntry, StoredLeaf, StoredBunch } from '../storage/types.js';

// Re-export for convenience
export type { Timestamp, TimestampReference, HistoryEntry, StoredLeaf, StoredBunch };

// ─── Concurrency Control ────────────────────────────────────────────────────

export interface ConcurrencyCheck {
  readonly expectedVersion: number;
}

export interface ConcurrencySuccess {
  readonly success: true;
}

export interface ConcurrencyConflict {
  readonly success: false;
  readonly code: 'VERSION_CONFLICT';
  readonly message: string;
  readonly currentVersion: number;
}

export type ConcurrencyResult = ConcurrencySuccess | ConcurrencyConflict;

// ─── History Eviction Event ─────────────────────────────────────────────────

export interface EvictionEvent {
  readonly path: string;
  readonly evictedCount: number;
  readonly depthLimit: number;
  readonly truncationStartedAt?: string;
}

// ─── Version Manager Interface ──────────────────────────────────────────────

export interface VersionManager {
  /**
   * Create a new Timestamp (T7.1).
   * requestTime = now; commitTime populated later by caller.
   */
  createTimestamp(channelIdentifier: string): Timestamp;

  /**
   * Finalise a timestamp with the commit time (T7.1).
   */
  finaliseTimestamp(timestamp: Timestamp): Timestamp;

  /**
   * Add a timestamp entry to a document's timestamp list and
   * return the reference (T7.2).
   */
  addTimestamp(timestampList: Timestamp[], timestamp: Timestamp): TimestampReference;

  /**
   * Create leaf metadata for a new leaf (T7.3).
   */
  createLeafMetadata(timestampRef: TimestampReference): StoredLeaf['metadata'];

  /**
   * Update a leaf: push current value to history, apply new value,
   * increment version, enforce history depth (T7.3, T7.5).
   */
  updateLeaf(
    leaf: StoredLeaf,
    newValue: unknown,
    timestampRef: TimestampReference,
    historyDepth: number,
  ): { updatedLeaf: StoredLeaf; eviction?: EvictionEvent };

  /**
   * Create bunch metadata for a new bunch (T7.4).
   */
  createBunchMetadata(timestampRef: TimestampReference): StoredBunch['metadata'];

  /**
   * Update a bunch's metadata after child update (T7.4, T7.5).
   */
  updateBunchMetadata(
    metadata: StoredBunch['metadata'],
    timestampRef: TimestampReference,
    historyDepth: number,
  ): { updatedMetadata: StoredBunch['metadata']; eviction?: EvictionEvent };

  /**
   * Check optimistic concurrency (T7.9, T7.10).
   * If expectedVersion is undefined, it's a blind write (always succeeds).
   */
  checkConcurrency(currentVersion: number, expectedVersion: number | undefined): ConcurrencyResult;

  /**
   * Retrieve a leaf's value at a specific timestamp index (T7.12).
   */
  getLeafAtTimestamp(leaf: StoredLeaf, targetTimestampIndex: number): unknown | undefined;
}
