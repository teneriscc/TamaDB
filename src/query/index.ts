/**
 * Query module — public API (Component 9)
 *
 * Exports the Query Engine implementation and associated types.
 */

export { QueryEngineImpl } from './query-engine.js';
export type {
  MultiRetrievalResult,
  NotFoundReason,
  QueryEngine,
  RetrievalError,
  RetrievalMode,
  RetrievalOptions,
  RetrievalResult,
  RetrievalSuccess,
  SearchResult,
  TtlCheckResult,
  TtlChecker,
} from './types.js';
