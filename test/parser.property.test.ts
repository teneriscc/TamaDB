/**
 * Property-based tests for Component 1: JSON Parser (T1.5, T1.6)
 *
 * Property 5: For all valid JSON documents (objects), parse → prettyPrint → parse
 *             produces an equivalent internal tree.
 *
 * Property 6: For all valid JSON Schema documents, parseSchema → prettyPrint → parseSchema
 *             produces an equivalent ValidationModel.
 *
 * Design reference: design.md § Correctness Properties 5 & 6
 * Validates: Requirements 24.5, 25.5
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  parseDocument,
  prettyPrintDocument,
  parseSchema,
  prettyPrintSchema,
} from '../src/parser/index.js';

// ─── Arbitraries ────────────────────────────────────────────────────────────

/**
 * Generate arbitrary JSON objects (not arrays/primitives) to match
 * TamaDB's constraint that document roots must be objects.
 */
const arbitraryJsonObject = fc.json().filter((json) => {
  try {
    const parsed = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
});

/**
 * Generate arbitrary JSON Schema-like objects. We produce valid JSON objects
 * with typical schema keywords to exercise the round-trip property.
 */
const arbitrarySchemaObject = fc
  .record({
    $schema: fc.constant('http://json-schema.org/draft-07/schema#'),
    type: fc.constantFrom('object', 'array', 'string', 'number', 'integer', 'boolean', 'null'),
    properties: fc.option(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
        fc.record({
          type: fc.constantFrom('string', 'number', 'integer', 'boolean', 'null', 'array', 'object'),
        }),
      ),
      { nil: undefined },
    ),
    required: fc.option(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_]/.test(s)), {
        minLength: 0,
        maxLength: 5,
      }),
      { nil: undefined },
    ),
  })
  .map((obj) => {
    // Remove undefined optional fields for clean JSON
    const clean: Record<string, unknown> = { $schema: obj.$schema, type: obj.type };
    if (obj.properties !== undefined) clean['properties'] = obj.properties;
    if (obj.required !== undefined) clean['required'] = obj.required;
    return JSON.stringify(clean);
  });

// ─── Property 5: Document Round-Trip ────────────────────────────────────────

describe('Property 5: Document Parser Round-Trip (T1.5)', () => {
  it('parse(prettyPrint(parse(x))) == parse(x) for all valid JSON objects', () => {
    fc.assert(
      fc.property(arbitraryJsonObject, (json) => {
        const first = parseDocument(json);
        // Must parse successfully (input guaranteed to be valid JSON object)
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        // Pretty-print and re-parse
        const printed = prettyPrintDocument(first.tree, 0);
        const second = parseDocument(printed);

        expect(second.ok).toBe(true);
        if (!second.ok) return;

        // Trees must be structurally equivalent
        expect(second.tree).toEqual(first.tree);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trips preserve key ordering', () => {
    fc.assert(
      fc.property(arbitraryJsonObject, (json) => {
        const first = parseDocument(json);
        if (!first.ok) return;

        const printed = prettyPrintDocument(first.tree, 0);
        const second = parseDocument(printed);
        if (!second.ok) return;

        // Key order in the tree must be identical
        const firstKeys = [...first.tree.children.keys()];
        const secondKeys = [...second.tree.children.keys()];
        expect(secondKeys).toEqual(firstKeys);
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Property 6: Schema Round-Trip ──────────────────────────────────────────

describe('Property 6: JSON Schema Parser Round-Trip (T1.6)', () => {
  it('parseSchema(prettyPrint(parseSchema(x))) == parseSchema(x) for all valid schemas', () => {
    fc.assert(
      fc.property(arbitrarySchemaObject, (json) => {
        const first = parseSchema(json);
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        // Pretty-print and re-parse
        const printed = prettyPrintSchema(first.model, 0);
        const second = parseSchema(printed);

        expect(second.ok).toBe(true);
        if (!second.ok) return;

        // Validation models must be equivalent
        expect(second.model).toEqual(first.model);
      }),
      { numRuns: 500 },
    );
  });

  it('preserves draft detection across round-trips', () => {
    fc.assert(
      fc.property(arbitrarySchemaObject, (json) => {
        const first = parseSchema(json);
        if (!first.ok) return;

        const printed = prettyPrintSchema(first.model, 0);
        const second = parseSchema(printed);
        if (!second.ok) return;

        expect(second.model.draft).toBe(first.model.draft);
      }),
      { numRuns: 200 },
    );
  });

  it('round-trips arbitrary JSON objects as schemas (structural preservation)', () => {
    // Any valid JSON object should round-trip through parseSchema/prettyPrintSchema
    // even if it's not a "correct" schema — the parser preserves structure.
    fc.assert(
      fc.property(arbitraryJsonObject, (json) => {
        const first = parseSchema(json);
        if (!first.ok) return; // skip non-objects (already filtered but be safe)

        const printed = prettyPrintSchema(first.model, 0);
        const second = parseSchema(printed);
        if (!second.ok) return;

        expect(second.model.schema).toEqual(first.model.schema);
      }),
      { numRuns: 300 },
    );
  });
});
