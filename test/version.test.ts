/**
 * Unit tests for Component 7: Version Manager
 *
 * Covers T7.1 (timestamps), T7.2 (timestamp list), T7.3 (leaf metadata/history),
 * T7.4 (bunch metadata), T7.5 (depth enforcement), T7.6 (eviction event),
 * T7.7 (depth 0), T7.8 (depth 1), T7.9 (concurrency check),
 * T7.10 (blind write), T7.11 (depth-0 versioning), T7.12 (point-in-time).
 */

import { describe, it, expect } from 'vitest';
import { VersionManagerImpl } from '../src/version/version-manager.js';
import type { StoredLeaf, Timestamp } from '../src/version/types.js';

const vm = new VersionManagerImpl();

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeLeaf(value: unknown, versionNo: number, tsIndex: number, history: { value: unknown; tsIndex: number }[] = []): StoredLeaf {
  return {
    value,
    metadata: { timestampRef: { index: tsIndex }, versionNo },
    history: history.map((h) => ({ value: h.value, timestampRef: { index: h.tsIndex } })),
  };
}

// ─── T7.1: Timestamp Creation ───────────────────────────────────────────────

describe('T7.1: Timestamp Creation', () => {
  it('creates a timestamp with requestTime and channelIdentifier', () => {
    const ts = vm.createTimestamp('channel-1');
    expect(ts.requestTime).toBeTruthy();
    expect(ts.channelIdentifier).toBe('channel-1');
    expect(ts.commitTime).toBe('');
  });

  it('finalises a timestamp with commitTime', () => {
    const ts = vm.createTimestamp('channel-1');
    const finalised = vm.finaliseTimestamp(ts);
    expect(finalised.commitTime).toBeTruthy();
    expect(finalised.requestTime).toBe(ts.requestTime);
    expect(finalised.channelIdentifier).toBe('channel-1');
  });
});

// ─── T7.2: Timestamp List & Version Number ──────────────────────────────────

describe('T7.2: Timestamp List', () => {
  it('adds timestamp to list and returns reference with correct index', () => {
    const list: Timestamp[] = [];
    const ts1 = vm.createTimestamp('ch-1');
    const ref1 = vm.addTimestamp(list, ts1);
    expect(ref1.index).toBe(0);
    expect(list).toHaveLength(1);

    const ts2 = vm.createTimestamp('ch-1');
    const ref2 = vm.addTimestamp(list, ts2);
    expect(ref2.index).toBe(1);
    expect(list).toHaveLength(2);
  });

  it('invariant: versionNo = timestamp list length (Increment 1)', () => {
    const list: Timestamp[] = [];
    vm.addTimestamp(list, vm.createTimestamp('ch-1'));
    vm.addTimestamp(list, vm.createTimestamp('ch-1'));
    vm.addTimestamp(list, vm.createTimestamp('ch-1'));
    // After 3 operations, list length = 3 = expected versionNo
    expect(list.length).toBe(3);
  });
});

// ─── T7.3: Leaf Metadata & History ──────────────────────────────────────────

describe('T7.3: Leaf Metadata', () => {
  it('creates leaf metadata with versionNo = 1', () => {
    const meta = vm.createLeafMetadata({ index: 0 });
    expect(meta.versionNo).toBe(1);
    expect(meta.timestampRef.index).toBe(0);
  });

  it('updateLeaf increments versionNo', () => {
    const leaf = makeLeaf('old', 1, 0);
    const { updatedLeaf } = vm.updateLeaf(leaf, 'new', { index: 1 }, 5);
    expect(updatedLeaf.metadata.versionNo).toBe(2);
    expect(updatedLeaf.value).toBe('new');
  });

  it('updateLeaf preserves previous value in history', () => {
    const leaf = makeLeaf('old', 1, 0);
    const { updatedLeaf } = vm.updateLeaf(leaf, 'new', { index: 1 }, 5);
    expect(updatedLeaf.history).toHaveLength(1);
    expect(updatedLeaf.history[0]?.value).toBe('old');
    expect(updatedLeaf.history[0]?.timestampRef.index).toBe(0);
  });

  it('versionNo = history.length + 1', () => {
    let leaf = makeLeaf('v1', 1, 0);
    ({ updatedLeaf: leaf } = vm.updateLeaf(leaf, 'v2', { index: 1 }, 10));
    ({ updatedLeaf: leaf } = vm.updateLeaf(leaf, 'v3', { index: 2 }, 10));
    ({ updatedLeaf: leaf } = vm.updateLeaf(leaf, 'v4', { index: 3 }, 10));
    expect(leaf.metadata.versionNo).toBe(4);
    expect(leaf.history.length).toBe(3); // 3 previous values
    expect(leaf.metadata.versionNo).toBe(leaf.history.length + 1);
  });
});

// ─── T7.4: Bunch Metadata ───────────────────────────────────────────────────

describe('T7.4: Bunch Metadata', () => {
  it('creates bunch metadata with versionNo = 1', () => {
    const meta = vm.createBunchMetadata({ index: 0 });
    expect(meta.versionNo).toBe(1);
    expect(meta.history).toHaveLength(0);
  });

  it('updateBunchMetadata increments versionNo', () => {
    const meta = vm.createBunchMetadata({ index: 0 });
    const { updatedMetadata } = vm.updateBunchMetadata(meta, { index: 1 }, 5);
    expect(updatedMetadata.versionNo).toBe(2);
    expect(updatedMetadata.timestampRef.index).toBe(1);
  });

  it('updateBunchMetadata pushes previous timestampRef to history', () => {
    const meta = vm.createBunchMetadata({ index: 0 });
    const { updatedMetadata } = vm.updateBunchMetadata(meta, { index: 1 }, 5);
    expect(updatedMetadata.history).toHaveLength(1);
    expect(updatedMetadata.history[0]?.index).toBe(0);
  });
});

// ─── T7.5: History Depth Enforcement (FIFO) ─────────────────────────────────

describe('T7.5: History Depth Enforcement', () => {
  it('evicts oldest entry when depth exceeded', () => {
    // Start with leaf at version 3, history of 2 entries, depth limit = 2
    const leaf = makeLeaf('v3', 3, 2, [
      { value: 'v1', tsIndex: 0 },
      { value: 'v2', tsIndex: 1 },
    ]);

    const { updatedLeaf, eviction } = vm.updateLeaf(leaf, 'v4', { index: 3 }, 2);
    // Should have evicted 1 entry (v1), keeping v2 and v3
    expect(updatedLeaf.history).toHaveLength(2);
    expect(updatedLeaf.history[0]?.value).toBe('v2');
    expect(updatedLeaf.history[1]?.value).toBe('v3');
    expect(eviction).toBeDefined();
    expect(eviction?.evictedCount).toBe(1);
  });

  it('no eviction when within depth', () => {
    const leaf = makeLeaf('v2', 2, 1, [{ value: 'v1', tsIndex: 0 }]);
    const { eviction } = vm.updateLeaf(leaf, 'v3', { index: 2 }, 5);
    expect(eviction).toBeUndefined();
  });

  it('bunch metadata FIFO eviction', () => {
    let meta = vm.createBunchMetadata({ index: 0 });
    ({ updatedMetadata: meta } = vm.updateBunchMetadata(meta, { index: 1 }, 2));
    ({ updatedMetadata: meta } = vm.updateBunchMetadata(meta, { index: 2 }, 2));
    const { updatedMetadata, eviction } = vm.updateBunchMetadata(meta, { index: 3 }, 2);

    expect(updatedMetadata.history).toHaveLength(2);
    expect(eviction).toBeDefined();
  });
});

// ─── T7.6: Eviction Event ───────────────────────────────────────────────────

describe('T7.6: Eviction Event', () => {
  it('provides eviction details for logging', () => {
    const leaf = makeLeaf('v3', 3, 2, [
      { value: 'v1', tsIndex: 0 },
      { value: 'v2', tsIndex: 1 },
    ]);
    const { eviction } = vm.updateLeaf(leaf, 'v4', { index: 3 }, 1);
    expect(eviction).toBeDefined();
    expect(eviction!.evictedCount).toBe(2); // was 2 entries, depth limit 1
    expect(eviction!.depthLimit).toBe(1);
  });
});

// ─── T7.7: Depth 0 Behaviour ────────────────────────────────────────────────

describe('T7.7: Depth 0', () => {
  it('no previous values retained at depth 0', () => {
    const leaf = makeLeaf('old', 1, 0);
    const { updatedLeaf } = vm.updateLeaf(leaf, 'new', { index: 1 }, 0);
    expect(updatedLeaf.history).toHaveLength(0);
    expect(updatedLeaf.value).toBe('new');
  });

  it('versionNo still increments at depth 0', () => {
    let leaf = makeLeaf('v1', 1, 0);
    ({ updatedLeaf: leaf } = vm.updateLeaf(leaf, 'v2', { index: 1 }, 0));
    ({ updatedLeaf: leaf } = vm.updateLeaf(leaf, 'v3', { index: 2 }, 0));
    expect(leaf.metadata.versionNo).toBe(3);
    expect(leaf.history).toHaveLength(0);
  });

  it('no eviction event at depth 0 (nothing to evict)', () => {
    const leaf = makeLeaf('old', 1, 0);
    const { eviction } = vm.updateLeaf(leaf, 'new', { index: 1 }, 0);
    expect(eviction).toBeUndefined();
  });

  it('bunch metadata at depth 0: no history retained', () => {
    const meta = vm.createBunchMetadata({ index: 0 });
    const { updatedMetadata } = vm.updateBunchMetadata(meta, { index: 1 }, 0);
    expect(updatedMetadata.history).toHaveLength(0);
    expect(updatedMetadata.versionNo).toBe(2);
  });
});

// ─── T7.8: Depth 1 Behaviour ────────────────────────────────────────────────

describe('T7.8: Depth 1', () => {
  it('retains exactly one previous value', () => {
    let leaf = makeLeaf('v1', 1, 0);
    ({ updatedLeaf: leaf } = vm.updateLeaf(leaf, 'v2', { index: 1 }, 1));
    expect(leaf.history).toHaveLength(1);
    expect(leaf.history[0]?.value).toBe('v1');

    ({ updatedLeaf: leaf } = vm.updateLeaf(leaf, 'v3', { index: 2 }, 1));
    expect(leaf.history).toHaveLength(1);
    // Oldest (v1) evicted, only v2 remains
    expect(leaf.history[0]?.value).toBe('v2');
  });
});

// ─── T7.9: Optimistic Concurrency Check ─────────────────────────────────────

describe('T7.9: Optimistic Concurrency', () => {
  it('succeeds when expected matches current', () => {
    const result = vm.checkConcurrency(5, 5);
    expect(result.success).toBe(true);
  });

  it('rejects when expected is less than current (stale)', () => {
    const result = vm.checkConcurrency(5, 3);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('VERSION_CONFLICT');
    expect(result.currentVersion).toBe(5);
  });

  it('rejects when expected is greater than current (inconsistent)', () => {
    const result = vm.checkConcurrency(5, 7);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('VERSION_CONFLICT');
  });
});

// ─── T7.10: Blind Write ─────────────────────────────────────────────────────

describe('T7.10: Blind Write', () => {
  it('always succeeds when no expected version provided', () => {
    const result = vm.checkConcurrency(100, undefined);
    expect(result.success).toBe(true);
  });
});

// ─── T7.11: Depth-0 Versioning with Concurrency ────────────────────────────

describe('T7.11: Depth-0 Versioning', () => {
  it('concurrency control works at depth 0', () => {
    // Simulate a document at version 3 with depth 0
    let leaf = makeLeaf('v1', 1, 0);
    ({ updatedLeaf: leaf } = vm.updateLeaf(leaf, 'v2', { index: 1 }, 0));
    ({ updatedLeaf: leaf } = vm.updateLeaf(leaf, 'v3', { index: 2 }, 0));

    // Version is 3, history is empty
    expect(leaf.metadata.versionNo).toBe(3);
    expect(leaf.history).toHaveLength(0);

    // Concurrency check still works
    expect(vm.checkConcurrency(3, 3).success).toBe(true);
    expect(vm.checkConcurrency(3, 2).success).toBe(false);
  });
});

// ─── T7.12: Point-in-Time Leaf Retrieval ────────────────────────────────────

describe('T7.12: Point-in-Time Retrieval', () => {
  it('retrieves current value by current timestamp index', () => {
    const leaf = makeLeaf('current', 3, 2, [
      { value: 'v1', tsIndex: 0 },
      { value: 'v2', tsIndex: 1 },
    ]);
    expect(vm.getLeafAtTimestamp(leaf, 2)).toBe('current');
  });

  it('retrieves historical value by timestamp index', () => {
    const leaf = makeLeaf('current', 3, 2, [
      { value: 'v1', tsIndex: 0 },
      { value: 'v2', tsIndex: 1 },
    ]);
    expect(vm.getLeafAtTimestamp(leaf, 0)).toBe('v1');
    expect(vm.getLeafAtTimestamp(leaf, 1)).toBe('v2');
  });

  it('returns undefined for evicted timestamp', () => {
    const leaf = makeLeaf('current', 5, 4, [
      // History only has indices 3 and 2 (0 and 1 were evicted)
      { value: 'v3', tsIndex: 2 },
      { value: 'v4', tsIndex: 3 },
    ]);
    expect(vm.getLeafAtTimestamp(leaf, 0)).toBeUndefined();
    expect(vm.getLeafAtTimestamp(leaf, 1)).toBeUndefined();
  });

  it('returns undefined for non-existent timestamp index', () => {
    const leaf = makeLeaf('current', 1, 0);
    expect(vm.getLeafAtTimestamp(leaf, 99)).toBeUndefined();
  });
});
