/**
 * TTL module — public API (Component 10)
 *
 * Exports the TTL Manager implementation and associated types.
 */

export { TtlManagerImpl } from './ttl-manager.js';
export type {
  Duration,
  ExpiryEntry,
  ExpiryReport,
  TtlCheckResult,
  TtlConfig,
  TtlFloorWarning,
  TtlManager,
  TtlScope,
} from './types.js';
