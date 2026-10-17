/**
 * Version module — public API (Component 7)
 *
 * Exports the Version Manager implementation and associated types.
 */

export { VersionManagerImpl } from './version-manager.js';
export type {
  ConcurrencyCheck,
  ConcurrencyConflict,
  ConcurrencyResult,
  ConcurrencySuccess,
  EvictionEvent,
  HistoryEntry,
  StoredBunch,
  StoredLeaf,
  Timestamp,
  TimestampReference,
  VersionManager,
} from './types.js';
