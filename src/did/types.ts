/**
 * D-Id Extractor types (T6.1–T6.10)
 *
 * Defines D-Id extraction mechanisms, composition rules, and warnings.
 *
 * Design reference: design.md § D-Id Extractor
 * Validates: Requirements 31.10–17, 1
 */

import type { DocumentIdentifier } from '../storage/types.js';
import type { DIdMetadata } from '../schema/types.js';

// ─── Identity Kind ──────────────────────────────────────────────────────────

export type IdentityKind = 'primary-key' | 'parent-key';

/**
 * A field annotated with identityKind in the schema.
 *
 * Identity fields may be nested at any depth within object properties (not only
 * at the schema's top level). The `path` is the ordered list of property-name
 * segments from the document root to the annotated scalar leaf. Arrays are never
 * descended into (Increment 1 treats arrays as atomic leaves), so every path
 * segment addresses an object property.
 */
export interface IdentityField {
  /**
   * Ordered property-name segments from the document root to the annotated
   * value. A top-level field has a single-segment path, e.g. `['orderId']`.
   * A nested field has multiple segments, e.g.
   * `['Identifier', 'CreatorReference', 'BusinessUnitCode']`.
   */
  readonly path: readonly string[];
  /**
   * Human-readable dotted rendering of `path` (e.g. `Identifier.Number`).
   * For a top-level field this equals the plain property name, preserving
   * backward compatibility with callers that treated the field as a name.
   */
  readonly fieldName: string;
  /** Role in the D-Id composition. */
  readonly kind: IdentityKind;
  /**
   * Position in the schema's identityKind discovery order (0-based).
   * Discovery is a deterministic depth-first traversal of object properties in
   * declaration order, so `declarationOrder` provides a stable cross-level
   * ordering used to assemble composed D-Ids.
   */
  readonly declarationOrder: number;
}

// ─── D-Id Definition (resolved from schema or metadata) ─────────────────────

export interface DIdDefinition {
  /** Source of the definition. */
  readonly source: 'identityKind' | 'metadata';
  /** Fields composing the D-Id, in assembly order (parent-keys first, then primary-keys). */
  readonly fields: readonly IdentityField[];
  /** Resulting D-Id type. */
  readonly type: 'single' | 'composed';
}

// ─── Extraction Result ──────────────────────────────────────────────────────

export interface ExtractionSuccess {
  readonly success: true;
  readonly dId: DocumentIdentifier;
}

export interface ExtractionError {
  readonly success: false;
  readonly code: string;
  readonly message: string;
}

export type ExtractionResult = ExtractionSuccess | ExtractionError;

// ─── Definition Resolution Result ───────────────────────────────────────────

export interface DefinitionSuccess {
  readonly success: true;
  readonly definition: DIdDefinition;
  readonly warnings: readonly RegistrationWarning[];
}

export interface DefinitionError {
  readonly success: false;
  readonly code: string;
  readonly message: string;
}

export type DefinitionResult = DefinitionSuccess | DefinitionError;

// ─── Registration Warnings ──────────────────────────────────────────────────

export interface RegistrationWarning {
  readonly code: WarningCode;
  readonly message: string;
}

export type WarningCode =
  | 'COMPLEX_IDENTITY_COMPOSITION'
  | 'LONG_COMPOSITE_DID'
  | 'IDENTITY_ORDER_AMBIGUOUS'
  | 'IDENTITY_KIND_METADATA_CONFLICT'
  | 'DEEPLY_NESTED_IDENTITY';

// ─── D-Id Extractor Interface ───────────────────────────────────────────────

export interface DIdExtractor {
  /**
   * Resolve the D-Id definition from a Master_Schema (T6.1–T6.4, T6.6–T6.8).
   * Uses identityKind annotations (primary) or metadata fallback.
   * Returns warnings for complex compositions.
   */
  resolveDefinition(
    schema: Record<string, unknown>,
    dIdMetadata?: DIdMetadata,
  ): DefinitionResult;

  /**
   * Extract a DocumentIdentifier from a document using a resolved definition (T6.5, T6.9, T6.10).
   */
  extract(
    document: Record<string, unknown>,
    definition: DIdDefinition,
  ): ExtractionResult;
}
