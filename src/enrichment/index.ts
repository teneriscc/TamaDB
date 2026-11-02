/**
 * Enrichment module — public API (Component 17)
 *
 * Exports the Enrichment Engine implementation and associated types.
 */

export { EnrichmentEngineImpl } from './enrichment-engine.js';
export type {
  BindingRegistrationError,
  BindingRegistrationResult,
  BindingRegistrationSuccess,
  EnrichmentBinding,
  EnrichmentConflict,
  EnrichmentConflictResolutionPolicy,
  EnrichmentConsistencyFailure,
  EnrichmentConsistencyResult,
  EnrichmentConsistencySuccess,
  EnrichmentEngine,
  EnrichmentPolicies,
  EnrichmentPrecedencePolicy,
  EnrichmentResult,
} from './types.js';
