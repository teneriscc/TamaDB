/**
 * Storage module — public API (Component 2)
 *
 * Exports the StorageAdapter interface, concrete implementations,
 * and the StorageManager facade.
 */

export { MemoryStore } from './memory-store.js';
export { DiskStore } from './disk-store.js';
export { HybridStore } from './hybrid-store.js';
export { StorageManager } from './storage-manager.js';
export type { StorageManagerOptions } from './storage-manager.js';
export { storageKey } from './types.js';
export type {
  BunchMetadata,
  ComposedKey,
  DocumentIdentifier,
  DocumentModel,
  HistoryEntry,
  InternalDocument,
  LeafMetadata,
  SingleKey,
  SoftDeleteType,
  StorageAdapter,
  StorageStrategyMode,
  StoredBunch,
  StoredLeaf,
  Timestamp,
  TimestampReference,
} from './types.js';
