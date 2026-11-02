/**
 * Document Manager module — public API (Component 8)
 *
 * Exports the Document Manager implementation and associated types.
 */

export { DocumentManagerImpl } from './document-manager.js';
export type { DocumentManagerDeps } from './document-manager.js';
export type {
  DocumentManager,
  SoftDeleteResult,
  StoreError,
  StoreHooks,
  StoreRequest,
  StoreResult,
  StoreSuccess,
  StoreWarning,
} from './types.js';
