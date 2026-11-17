/**
 * Schema module — public API (Component 3)
 *
 * Exports the SchemaManager implementation and associated types.
 */

export { SchemaManagerImpl } from './schema-manager.js';
export type {
  ConsistencyConflict,
  ConsistencyConflictCode,
  ConsistencyFailure,
  ConsistencyResult,
  ConsistencySuccess,
  DecommissionResult,
  DIdMetadata,
  RegisterResult,
  RegisterSchemaError,
  RegisterSchemaOptions,
  RegisterSchemaResult,
  SchemaEntry,
  SchemaLifecycle,
  SchemaManager,
  SchemaRef,
  SchemaVersion,
  ValidationError,
  ValidationFailure,
  ValidationResult,
  ValidationSuccess,
} from './types.js';
