/**
 * Schema Manager types (T3.1–T3.10)
 *
 * Defines schema lifecycle, validation results, consistency checks,
 * and the SchemaManager interface.
 *
 * Design reference: design.md § Schema Manager
 * Validates: Requirements 17, 20, 24, 29, 30, 31, 43, 46
 */

import type { DocumentModel } from '../storage/types.js';

// ─── Schema Identity & Lifecycle ────────────────────────────────────────────

/** Unique identifier for a schema in the repository. */
export type SchemaRef = string;

export type SchemaLifecycle = 'active' | 'decommissioned';

/**
 * A registered schema entry in the schema repository.
 */
export interface SchemaEntry {
  /** Unique schema reference identifier. */
  readonly ref: SchemaRef;
  /** The raw JSON Schema object. */
  readonly schema: Record<string, unknown>;
  /** Version number (increments on update). */
  readonly version: number;
  /** Version history: previous schema versions with timestamps. */
  readonly versions: readonly SchemaVersion[];
  /** Current lifecycle state. */
  lifecycle: SchemaLifecycle;
  /** Optional D-Id definition (metadata fallback for third-party schemas). */
  readonly dIdDefinition?: DIdMetadata;
  /** Timestamp of creation. */
  readonly createdAt: string;
  /** Timestamp of last modification. */
  updatedAt: string;
}

export interface SchemaVersion {
  readonly version: number;
  readonly schema: Record<string, unknown>;
  readonly timestamp: string;
}

// ─── D-Id Metadata (fallback mechanism) ─────────────────────────────────────

export interface DIdMetadata {
  readonly type: 'single' | 'composed';
  readonly fields: readonly string[];
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface ValidationSuccess {
  readonly valid: true;
}

export interface ValidationFailure {
  readonly valid: false;
  readonly errors: readonly ValidationError[];
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly keyword: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

// ─── Schema Consistency ─────────────────────────────────────────────────────

export interface ConsistencySuccess {
  readonly consistent: true;
}

export interface ConsistencyFailure {
  readonly consistent: false;
  readonly conflicts: readonly ConsistencyConflict[];
}

export interface ConsistencyConflict {
  readonly field: string;
  readonly reason: string;
  readonly code: ConsistencyConflictCode;
}

export type ConsistencyConflictCode =
  | 'CHANNEL_FIELD_NOT_IN_MASTER'
  | 'CHANNEL_REQUIRED_NOT_IN_MASTER'
  | 'FIELD_TYPE_MISMATCH'
  | 'MASTER_REQUIRED_NOT_IN_CHANNEL';

export type ConsistencyResult = ConsistencySuccess | ConsistencyFailure;

// ─── Schema Registration ────────────────────────────────────────────────────

export interface RegisterSchemaOptions {
  readonly ref: SchemaRef;
  readonly schema: Record<string, unknown>;
  readonly dIdDefinition?: DIdMetadata;
}

export interface RegisterSchemaResult {
  readonly success: true;
  readonly ref: SchemaRef;
  readonly version: number;
}

export interface RegisterSchemaError {
  readonly success: false;
  readonly code: string;
  readonly message: string;
}

export type RegisterResult = RegisterSchemaResult | RegisterSchemaError;

// ─── Decommission ───────────────────────────────────────────────────────────

export interface DecommissionResult {
  readonly success: boolean;
  readonly code?: string;
  readonly message?: string;
}

// ─── Schema Manager Interface ───────────────────────────────────────────────

export interface SchemaManager {
  /**
   * Register a new schema in the repository (T3.1).
   */
  register(options: RegisterSchemaOptions): RegisterResult;

  /**
   * Retrieve a schema entry by ref (T3.2).
   */
  get(ref: SchemaRef): SchemaEntry | undefined;

  /**
   * Update an existing schema (creates new version; T3.3).
   */
  update(ref: SchemaRef, newSchema: Record<string, unknown>): RegisterResult;

  /**
   * Decommission a schema (T3.4).
   * Rejects if the schema is an active Master_Schema (Req 43.6).
   */
  decommission(ref: SchemaRef): DecommissionResult;

  /**
   * Reactivate a decommissioned schema (T3.5).
   */
  reactivate(ref: SchemaRef): DecommissionResult;

  /**
   * Validate a document against a schema using the specified document model (T3.7).
   * Under DCM: all required fields present, no extra fields, types match.
   */
  validate(document: Record<string, unknown>, ref: SchemaRef, model: DocumentModel): ValidationResult;

  /**
   * Check consistency between a Channel_Schema and a Master_Schema (T3.8).
   */
  checkConsistency(channelSchemaRef: SchemaRef, masterSchemaRef: SchemaRef, model: DocumentModel): ConsistencyResult;

  /**
   * Check if a schema is currently referenced as a Master_Schema by any Document_Type.
   * Used by decommission protection (T3.6).
   */
  isActiveMasterSchema(ref: SchemaRef): boolean;

  /**
   * Register a callback to check if a schema is an active Master_Schema.
   * This allows the Document_Type Registry (C4) to provide this information
   * without creating a circular dependency.
   */
  setMasterSchemaChecker(checker: (ref: SchemaRef) => boolean): void;

  /**
   * List all registered schemas.
   */
  list(): SchemaEntry[];
}
