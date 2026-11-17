/**
 * Quarantine module — public API (Component 11)
 *
 * Exports the Quarantine Store implementation and associated types.
 */

export { QuarantineStoreImpl } from './quarantine-store.js';
export type {
  QuarantineContext,
  QuarantineEntry,
  QuarantineListOptions,
  QuarantinePolicy,
  QuarantineStore,
  QuarantineUsage,
  RejectionType,
} from './types.js';
