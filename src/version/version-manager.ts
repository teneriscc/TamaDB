/**
 * Version Manager implementation (T7.1–T7.12)
 *
 * Manages timestamps, version numbers, history chains with depth-based
 * FIFO eviction, and optimistic concurrency control.
 *
 * Design reference: design.md § Version Manager
 * Validates: Requirements 2, 3, 4, 23, 33
 */

import type {
  EvictionEvent,
  HistoryEntry,
  StoredBunch,
  StoredLeaf,
  Timestamp,
  TimestampReference,
  ConcurrencyResult,
  VersionManager,
} from './types.js';

export class VersionManagerImpl implements VersionManager {

  // ─── T7.1: Timestamp Creation ───────────────────────────────────────────

  createTimestamp(channelIdentifier: string): Timestamp {
    return {
      requestTime: new Date().toISOString(),
      commitTime: '', // Finalised after write completes
      channelIdentifier,
    };
  }

  finaliseTimestamp(timestamp: Timestamp): Timestamp {
    return {
      ...timestamp,
      commitTime: new Date().toISOString(),
    };
  }

  // ─── T7.2: Timestamp List & Version Number ─────────────────────────────

  addTimestamp(timestampList: Timestamp[], timestamp: Timestamp): TimestampReference {
    const index = timestampList.length;
    timestampList.push(timestamp);
    return { index };
  }

  // ─── T7.3: Leaf Metadata & History ─────────────────────────────────────

  createLeafMetadata(timestampRef: TimestampReference): StoredLeaf['metadata'] {
    return { timestampRef, versionNo: 1 };
  }

  /**
   * Update a leaf: push current value to history (if depth > 0),
   * apply new value, increment versionNo, enforce FIFO eviction.
   *
   * T7.3: Leaf metadata update
   * T7.5: History depth enforcement (FIFO)
   * T7.7: Depth 0 — no previous values retained
   * T7.8: Depth 1 — one previous value
   */
  updateLeaf(
    leaf: StoredLeaf,
    newValue: unknown,
    timestampRef: TimestampReference,
    historyDepth: number,
  ): { updatedLeaf: StoredLeaf; eviction?: EvictionEvent } {
    let newHistory: HistoryEntry[];
    let eviction: EvictionEvent | undefined;

    if (historyDepth === 0) {
      // T7.7: No previous values retained; history is always empty
      newHistory = [];
    } else {
      // Push current value to history
      const previousEntry: HistoryEntry = {
        value: leaf.value,
        timestampRef: leaf.metadata.timestampRef,
      };

      newHistory = [...leaf.history, previousEntry];

      // T7.5: FIFO eviction when exceeding configured depth
      if (newHistory.length > historyDepth) {
        const evictCount = newHistory.length - historyDepth;
        newHistory = newHistory.slice(evictCount);
        eviction = {
          path: '', // Caller should populate with the actual dot-notation path
          evictedCount: evictCount,
          depthLimit: historyDepth,
        };
      }
    }

    const updatedLeaf: StoredLeaf = {
      value: newValue,
      metadata: {
        timestampRef,
        versionNo: leaf.metadata.versionNo + 1,
      },
      history: newHistory,
    };

    return eviction !== undefined
      ? { updatedLeaf, eviction }
      : { updatedLeaf };
  }

  // ─── T7.4: Bunch Metadata ──────────────────────────────────────────────

  createBunchMetadata(timestampRef: TimestampReference): StoredBunch['metadata'] {
    return { timestampRef, versionNo: 1, history: [] };
  }

  /**
   * Update a bunch's metadata: push current timestampRef to history,
   * apply new timestampRef, increment versionNo, enforce FIFO eviction.
   *
   * T7.4: Bunch metadata derived from most recent child
   * T7.5: History depth enforcement
   */
  updateBunchMetadata(
    metadata: StoredBunch['metadata'],
    timestampRef: TimestampReference,
    historyDepth: number,
  ): { updatedMetadata: StoredBunch['metadata']; eviction?: EvictionEvent } {
    let newHistory: TimestampReference[];
    let eviction: EvictionEvent | undefined;

    if (historyDepth === 0) {
      // No history retained
      newHistory = [];
    } else {
      // Push current timestampRef to history
      newHistory = [...metadata.history, metadata.timestampRef];

      // FIFO eviction
      if (newHistory.length > historyDepth) {
        const evictCount = newHistory.length - historyDepth;
        newHistory = newHistory.slice(evictCount);
        eviction = {
          path: '',
          evictedCount: evictCount,
          depthLimit: historyDepth,
        };
      }
    }

    const updatedMetadata: StoredBunch['metadata'] = {
      timestampRef,
      versionNo: metadata.versionNo + 1,
      history: newHistory,
    };

    return eviction !== undefined
      ? { updatedMetadata, eviction }
      : { updatedMetadata };
  }

  // ─── T7.9, T7.10: Optimistic Concurrency Control ──────────────────────

  /**
   * Check optimistic concurrency.
   *
   * T7.9: If expectedVersion is provided and doesn't match currentVersion → conflict
   * T7.10: If expectedVersion is undefined → blind write (last-write-wins)
   * T7.11: Always works because versionNo is always maintained (even at depth 0)
   */
  checkConcurrency(currentVersion: number, expectedVersion: number | undefined): ConcurrencyResult {
    // T7.10: Blind write — no version provided, always succeeds
    if (expectedVersion === undefined) {
      return { success: true };
    }

    // T7.9: Optimistic check — reject if mismatch (stale or inconsistent)
    if (expectedVersion !== currentVersion) {
      return {
        success: false,
        code: 'VERSION_CONFLICT',
        message: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}`,
        currentVersion,
      };
    }

    return { success: true };
  }

  // ─── T7.12: Point-in-Time Leaf Retrieval ────────────────────────────────

  /**
   * Retrieve a leaf's value at a specific timestamp index.
   * Searches history chain (most recent to oldest), then current value.
   * Returns undefined if the timestamp has been evicted.
   */
  getLeafAtTimestamp(leaf: StoredLeaf, targetTimestampIndex: number): unknown | undefined {
    // Check current value
    if (leaf.metadata.timestampRef.index === targetTimestampIndex) {
      return leaf.value;
    }

    // Search history (newest to oldest, since history is ordered oldest-first)
    for (let i = leaf.history.length - 1; i >= 0; i--) {
      const entry = leaf.history[i]!;
      if (entry.timestampRef.index === targetTimestampIndex) {
        return entry.value;
      }
    }

    // Timestamp not found — evicted or never existed
    return undefined;
  }
}
