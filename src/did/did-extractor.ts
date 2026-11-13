/**
 * D-Id Extractor implementation (T6.1–T6.10)
 *
 * Extracts Document_Identifiers from documents using identityKind
 * annotations in the Master_Schema or metadata fallback.
 *
 * Design reference: design.md § D-Id Extractor
 * Validates: Requirements 31.10–17, 1
 */

import type { DocumentIdentifier } from '../storage/types.js';
import type { DIdMetadata } from '../schema/types.js';
import type {
  DefinitionResult,
  DIdDefinition,
  DIdExtractor,
  ExtractionResult,
  IdentityField,
  IdentityKind,
  RegistrationWarning,
} from './types.js';

export class DIdExtractorImpl implements DIdExtractor {

  // ─── T6.1–T6.4, T6.6–T6.8: Resolve D-Id Definition ──────────────────

  resolveDefinition(
    schema: Record<string, unknown>,
    dIdMetadata?: DIdMetadata,
  ): DefinitionResult {
    // T6.1: Scan schema for identityKind annotations
    const inlineFields = this.scanIdentityKind(schema);

    // T6.2: Check metadata fallback
    const hasInline = inlineFields.length > 0;
    const hasMetadata = dIdMetadata !== undefined && dIdMetadata.fields.length > 0;

    // T6.6: Reject when neither mechanism defines D-Id
    if (!hasInline && !hasMetadata) {
      return {
        success: false,
        code: 'NO_DID_DEFINITION',
        message: 'Neither identityKind annotations nor metadata D-Id definition provided',
      };
    }

    const warnings: RegistrationWarning[] = [];

    // T6.3: Precedence — inline wins; warn on conflict
    let definition: DIdDefinition;
    if (hasInline) {
      // T6.7: At least one primary-key must exist
      const primaryKeys = inlineFields.filter((f) => f.kind === 'primary-key');
      if (primaryKeys.length === 0) {
        return {
          success: false,
          code: 'NO_PRIMARY_KEY',
          message: 'identityKind annotations found but no primary-key field defined',
        };
      }

      if (hasMetadata) {
        // Both present — use inline, warn on conflict.
        // Compare against the dotted rendering so nested inline paths compare
        // meaningfully against metadata field references.
        const inlineFieldNames = inlineFields.map((f) => f.fieldName);
        const metadataFields = dIdMetadata!.fields;
        const conflict = !arraysEqual(inlineFieldNames, [...metadataFields]);
        if (conflict) {
          warnings.push({
            code: 'IDENTITY_KIND_METADATA_CONFLICT',
            message: 'Inline identityKind and metadata D-Id definition conflict; using inline',
          });
        }
      }

      // T6.4: Assembly order — parent-keys first (declaration order), then primary-keys (declaration order)
      const parentKeys = inlineFields
        .filter((f) => f.kind === 'parent-key')
        .sort((a, b) => a.declarationOrder - b.declarationOrder);
      const sortedPrimary = primaryKeys
        .sort((a, b) => a.declarationOrder - b.declarationOrder);

      const orderedFields = [...parentKeys, ...sortedPrimary];
      const type = orderedFields.length === 1 ? 'single' : 'composed';

      definition = { source: 'identityKind', fields: orderedFields, type };

      // T6.8: Registration warnings
      warnings.push(...this.checkWarnings(parentKeys, sortedPrimary, inlineFields));
    } else {
      // Metadata fallback only. A metadata field reference may itself be a
      // dotted path (e.g. 'Identifier.Number'); split it into segments so the
      // extractor can resolve nested values the same way as inline paths.
      const metadataFields: IdentityField[] = dIdMetadata!.fields.map((fieldName, idx) => {
        const name = fieldName as string;
        const path = splitPath(name);
        return {
          path,
          fieldName: name,
          kind: 'primary-key' as IdentityKind,
          declarationOrder: idx,
        };
      });

      const type = metadataFields.length === 1 ? 'single' : 'composed';
      definition = { source: 'metadata', fields: metadataFields, type };
    }

    return { success: true, definition, warnings };
  }

  // ─── T6.5, T6.9, T6.10: Extract D-Id from Document ───────────────────

  extract(
    document: Record<string, unknown>,
    definition: DIdDefinition,
  ): ExtractionResult {
    const parts: string[] = [];

    for (const field of definition.fields) {
      const resolved = resolvePath(document, field.path);

      if (resolved.kind === 'missing') {
        return {
          success: false,
          code: 'MISSING_IDENTITY_FIELD',
          message: `Identity field '${field.fieldName}' is missing or null in the document`,
        };
      }

      if (resolved.kind === 'non-scalar') {
        return {
          success: false,
          code: 'IDENTITY_FIELD_NOT_SCALAR',
          message:
            `Identity field '${field.fieldName}' resolved to a ${resolved.typeLabel}, ` +
            `but a D-Id part must be a scalar (string, number, or boolean)`,
        };
      }

      // Convert the scalar value to string for D-Id composition.
      parts.push(String(resolved.value));
    }

    if (parts.length === 0) {
      return {
        success: false,
        code: 'EMPTY_DID',
        message: 'No identity fields resolved',
      };
    }

    // T6.9: Single-key D-Id
    if (parts.length === 1) {
      const dId: DocumentIdentifier = { type: 'single', value: parts[0]! };
      return { success: true, dId };
    }

    // T6.10: Composed D-Id
    const dId: DocumentIdentifier = { type: 'composed', parts };
    return { success: true, dId };
  }

  // ─── Private: T6.1 — Scan identityKind annotations ────────────────────

  /**
   * Scan a schema for identityKind annotations at any object-nesting depth.
   *
   * Traversal rules:
   * - Descends into nested object property schemas (`properties`) recursively.
   * - Does NOT descend into arrays (`items`): Increment 1 treats arrays as
   *   atomic leaves with no element-level addressing, so an array cannot hold a
   *   D-Id part.
   * - Resolves `$ref` pointers within the same schema document so that
   *   `#/definitions/...`-style schemas (common in real-world payloads) are
   *   traversed. Circular refs are guarded against.
   * - Discovery order is a deterministic depth-first walk of properties in
   *   declaration order. The 0-based `declarationOrder` counter increments once
   *   per discovered identity field and provides a stable cross-level ordering.
   *
   * A top-level annotation yields a single-segment path, so pre-existing flat
   * schemas behave exactly as before (backward compatible).
   */
  private scanIdentityKind(schema: Record<string, unknown>): IdentityField[] {
    const fields: IdentityField[] = [];
    const counter = { order: 0 };
    this.scanProperties(schema, schema, [], fields, counter, new Set<unknown>());
    return fields;
  }

  /**
   * Recursive worker for {@link scanIdentityKind}.
   *
   * @param node      The current schema node whose `properties` to scan.
   * @param root      The root schema document, used to resolve `$ref`.
   * @param pathSoFar Property-name segments from the document root to `node`.
   * @param out       Accumulator of discovered identity fields.
   * @param counter   Shared discovery-order counter.
   * @param seen      Visited schema nodes, to guard against circular `$ref`.
   */
  private scanProperties(
    node: Record<string, unknown>,
    root: Record<string, unknown>,
    pathSoFar: readonly string[],
    out: IdentityField[],
    counter: { order: number },
    seen: Set<unknown>,
  ): void {
    const resolvedNode = this.resolveRef(node, root, seen);
    if (!resolvedNode) return;

    const properties = resolvedNode['properties'];
    if (!properties || typeof properties !== 'object') return;

    for (const [propName, rawPropSchema] of Object.entries(properties as Record<string, unknown>)) {
      if (!rawPropSchema || typeof rawPropSchema !== 'object') continue;

      const propSchema = this.resolveRef(rawPropSchema as Record<string, unknown>, root, seen);
      if (!propSchema) continue;

      const path = [...pathSoFar, propName];

      // An identityKind annotation marks this property as a D-Id part. It must
      // sit on the scalar leaf itself; we do not descend past an annotated node.
      const kind = propSchema['identityKind'];
      if (kind === 'primary-key' || kind === 'parent-key') {
        out.push({
          path,
          fieldName: path.join('.'),
          kind,
          declarationOrder: counter.order++,
        });
        continue;
      }

      // Otherwise, descend into nested object properties (never into arrays).
      if (propSchema['properties'] && typeof propSchema['properties'] === 'object') {
        this.scanProperties(propSchema, root, path, out, counter, seen);
      }
    }
  }

  /**
   * Resolve a same-document `$ref` (e.g. `#/definitions/foo`) to its target
   * node. Non-ref nodes are returned unchanged. Returns undefined on a ref that
   * cannot be resolved or that forms a cycle.
   */
  private resolveRef(
    node: Record<string, unknown>,
    root: Record<string, unknown>,
    seen: Set<unknown>,
  ): Record<string, unknown> | undefined {
    let current = node;
    // Follow chains of $ref (rare, but possible), with cycle protection.
    while (typeof current['$ref'] === 'string') {
      const ref = current['$ref'] as string;
      if (seen.has(ref)) return undefined; // circular
      seen.add(ref);
      const target = this.derefPointer(ref, root);
      if (!target) return undefined;
      current = target;
    }
    return current;
  }

  /** Dereference a local JSON Pointer of the form `#/a/b/c`. */
  private derefPointer(ref: string, root: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!ref.startsWith('#/')) return undefined; // only same-document refs supported
    const segments = ref
      .slice(2)
      .split('/')
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')); // JSON Pointer unescape
    let cursor: unknown = root;
    for (const seg of segments) {
      if (!cursor || typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[seg];
    }
    return cursor && typeof cursor === 'object' ? (cursor as Record<string, unknown>) : undefined;
  }

  // ─── Private: T6.8 — Registration warnings ────────────────────────────

  private checkWarnings(
    parentKeys: IdentityField[],
    primaryKeys: IdentityField[],
    _allFields: IdentityField[],
  ): RegistrationWarning[] {
    const warnings: RegistrationWarning[] = [];
    const totalParts = parentKeys.length + primaryKeys.length;

    // COMPLEX_IDENTITY_COMPOSITION: composite primary-keys + composite parent-keys
    if (parentKeys.length > 1 && primaryKeys.length > 1) {
      warnings.push({
        code: 'COMPLEX_IDENTITY_COMPOSITION',
        message: 'Composite primary-keys combined with composite parent-keys; URL readability may suffer',
      });
    }

    // LONG_COMPOSITE_DID: total parts > 3
    if (totalParts > 3) {
      warnings.push({
        code: 'LONG_COMPOSITE_DID',
        message: `D-Id has ${totalParts} parts (> 3); URL length and glob complexity increase`,
      });
    }

    // IDENTITY_ORDER_AMBIGUOUS: parent-key discovered after primary-key.
    // declarationOrder is the deterministic depth-first discovery order, so this
    // check remains meaningful across nesting levels.
    if (parentKeys.length > 0 && primaryKeys.length > 0) {
      const firstPrimaryOrder = Math.min(...primaryKeys.map((f) => f.declarationOrder));
      const parentAfterPrimary = parentKeys.some((f) => f.declarationOrder > firstPrimaryOrder);
      if (parentAfterPrimary) {
        warnings.push({
          code: 'IDENTITY_ORDER_AMBIGUOUS',
          message: 'Parent-key discovered after primary-key in schema; discovery (depth-first declaration) order determines assembly order',
        });
      }
    }

    // DEEPLY_NESTED_IDENTITY: any identity field nested deeper than 3 segments.
    // Deep paths are supported but can be brittle (schema refactors move them)
    // and harder to reason about, so surface a non-blocking advisory.
    const deepest = Math.max(0, ...[...parentKeys, ...primaryKeys].map((f) => f.path.length));
    if (deepest > 3) {
      warnings.push({
        code: 'DEEPLY_NESTED_IDENTITY',
        message: `An identity field is nested ${deepest} levels deep; deep identity paths are supported but sensitive to schema restructuring`,
      });
    }

    return warnings;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, idx) => val === b[idx]);
}

/** Split a dotted field reference (e.g. `Identifier.Number`) into segments. */
function splitPath(name: string): string[] {
  return name.split('.').filter((s) => s.length > 0);
}

/** Outcome of resolving an identity path against a document. */
type PathResolution =
  | { kind: 'scalar'; value: string | number | boolean }
  | { kind: 'missing' }
  | { kind: 'non-scalar'; typeLabel: string };

/**
 * Walk `path` through `document` segment by segment.
 *
 * - Any missing/null segment (or a non-object encountered mid-path) yields
 *   `missing`.
 * - Arrays are never traversed: encountering an array mid-path yields
 *   `non-scalar` (arrays are atomic leaves in Increment 1 and cannot address a
 *   D-Id part), and an array terminal likewise yields `non-scalar`.
 * - A terminal object yields `non-scalar` (a D-Id part must be a scalar leaf).
 * - A terminal string/number/boolean yields `scalar`.
 */
function resolvePath(document: Record<string, unknown>, path: readonly string[]): PathResolution {
  let cursor: unknown = document;

  for (let i = 0; i < path.length; i++) {
    if (cursor === undefined || cursor === null) return { kind: 'missing' };
    if (typeof cursor !== 'object' || Array.isArray(cursor)) {
      // Cannot descend further: a scalar or array sits where an object is needed.
      return Array.isArray(cursor) ? { kind: 'non-scalar', typeLabel: 'array' } : { kind: 'missing' };
    }
    cursor = (cursor as Record<string, unknown>)[path[i]!];
  }

  if (cursor === undefined || cursor === null) return { kind: 'missing' };

  const t = typeof cursor;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return { kind: 'scalar', value: cursor as string | number | boolean };
  }
  return { kind: 'non-scalar', typeLabel: Array.isArray(cursor) ? 'array' : 'object' };
}
