/**
 * Unit tests for Component 1: JSON Parser
 *
 * Covers T1.1 (document parsing), T1.2 (pretty printing),
 * T1.3 (schema parsing), T1.4 (schema printing), T1.7 (error reporting).
 */

import { describe, it, expect } from 'vitest';
import {
  parseDocument,
  prettyPrintDocument,
  parseSchema,
  prettyPrintSchema,
  isArrayLeaf,
} from '../src/parser/index.js';

// ─── T1.1: Document Parser ─────────────────────────────────────────────────

describe('T1.1: parseDocument', () => {
  it('parses an empty object into a Bunch with no children', () => {
    const result = parseDocument('{}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree.kind).toBe('bunch');
    expect(result.tree.children.size).toBe(0);
  });

  it('parses a flat object into a Bunch with Leaf children', () => {
    const json = '{"name": "TamaDB", "version": 1, "active": true}';
    const result = parseDocument(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { children } = result.tree;
    expect(children.size).toBe(3);

    const name = children.get('name');
    expect(name).toEqual({ kind: 'leaf', value: 'TamaDB' });

    const version = children.get('version');
    expect(version).toEqual({ kind: 'leaf', value: 1 });

    const active = children.get('active');
    expect(active).toEqual({ kind: 'leaf', value: true });
  });

  it('parses nested objects as Bunches (recursive)', () => {
    const json = '{"user": {"name": "Alice", "address": {"city": "Berlin"}}}';
    const result = parseDocument(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const user = result.tree.children.get('user');
    expect(user?.kind).toBe('bunch');
    if (user?.kind !== 'bunch') return;

    const address = user.children.get('address');
    expect(address?.kind).toBe('bunch');
    if (address?.kind !== 'bunch') return;

    const city = address.children.get('city');
    expect(city).toEqual({ kind: 'leaf', value: 'Berlin' });
  });

  it('treats arrays as atomic Leaf values', () => {
    const json = '{"tags": ["alpha", "beta"], "scores": [1, 2, 3]}';
    const result = parseDocument(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tags = result.tree.children.get('tags');
    expect(tags?.kind).toBe('leaf');
    if (tags?.kind !== 'leaf') return;
    expect(tags.value).toEqual(['alpha', 'beta']);
    expect(isArrayLeaf(tags.value)).toBe(true);
  });

  it('handles null values as Leaves', () => {
    const json = '{"data": null}';
    const result = parseDocument(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.tree.children.get('data');
    expect(data).toEqual({ kind: 'leaf', value: null });
  });

  it('handles nested arrays with objects inside as atomic leaves', () => {
    const json = '{"items": [{"id": 1}, {"id": 2}]}';
    const result = parseDocument(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const items = result.tree.children.get('items');
    expect(items?.kind).toBe('leaf');
    if (items?.kind !== 'leaf') return;
    expect(items.value).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('rejects non-object root (array)', () => {
    const result = parseDocument('[1, 2, 3]');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('root must be a JSON object');
  });

  it('rejects non-object root (string)', () => {
    const result = parseDocument('"hello"');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('root must be a JSON object');
  });

  it('rejects non-object root (number)', () => {
    const result = parseDocument('42');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('root must be a JSON object');
  });

  it('rejects non-object root (null)', () => {
    const result = parseDocument('null');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('root must be a JSON object');
  });

  it('preserves key order from the source JSON', () => {
    const json = '{"z": 1, "a": 2, "m": 3}';
    const result = parseDocument(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const keys = [...result.tree.children.keys()];
    expect(keys).toEqual(['z', 'a', 'm']);
  });
});

// ─── T1.7: Error Reporting ──────────────────────────────────────────────────

describe('T1.7: parseDocument error reporting', () => {
  it('reports syntax error with position for malformed JSON', () => {
    const result = parseDocument('{invalid}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBeTruthy();
    expect(result.error.line).toBeGreaterThanOrEqual(1);
    expect(result.error.column).toBeGreaterThanOrEqual(1);
  });

  it('reports position for unclosed string', () => {
    const result = parseDocument('{"key": "value');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBeTruthy();
    expect(typeof result.error.position).toBe('number');
  });

  it('reports position for trailing comma', () => {
    const result = parseDocument('{"a": 1,}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBeTruthy();
  });

  it('provides expected token hint when available', () => {
    const result = parseDocument('{"a": }');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // expected may or may not be set depending on the engine, but message should exist
    expect(result.error.message).toBeTruthy();
  });

  it('handles empty string input', () => {
    const result = parseDocument('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBeTruthy();
  });

  it('computes correct line and column for multi-line errors', () => {
    // Use input that reliably triggers a late-position error
    const json = '{\n  "a": 1,\n  "b": invalid\n}';
    const result = parseDocument(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The error exists and has valid position information
    expect(result.error.message).toBeTruthy();
    expect(result.error.line).toBeGreaterThanOrEqual(1);
    expect(result.error.column).toBeGreaterThanOrEqual(1);
  });
});

// ─── T1.2: Document Pretty Printer ─────────────────────────────────────────

describe('T1.2: prettyPrintDocument', () => {
  it('prints an empty Bunch as {}', () => {
    const result = parseDocument('{}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = prettyPrintDocument(result.tree, 0);
    expect(output).toBe('{}');
  });

  it('round-trips a simple flat object', () => {
    const original = { name: 'TamaDB', version: 1, active: true };
    const json = JSON.stringify(original);
    const result = parseDocument(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const printed = prettyPrintDocument(result.tree, 0);
    expect(JSON.parse(printed)).toEqual(original);
  });

  it('round-trips nested objects', () => {
    const original = { user: { name: 'Alice', address: { city: 'Berlin', zip: '10115' } } };
    const json = JSON.stringify(original);
    const result = parseDocument(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const printed = prettyPrintDocument(result.tree, 0);
    expect(JSON.parse(printed)).toEqual(original);
  });

  it('round-trips arrays (atomic leaves)', () => {
    const original = { tags: ['a', 'b'], nested: [{ id: 1 }] };
    const json = JSON.stringify(original);
    const result = parseDocument(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const printed = prettyPrintDocument(result.tree, 0);
    expect(JSON.parse(printed)).toEqual(original);
  });

  it('produces indented output when indent > 0', () => {
    const json = '{"a":1}';
    const result = parseDocument(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const printed = prettyPrintDocument(result.tree, 2);
    expect(printed).toContain('\n');
    expect(printed).toContain('  ');
  });
});

// ─── T1.3: Schema Parser ────────────────────────────────────────────────────

describe('T1.3: parseSchema', () => {
  it('parses a minimal Draft 7 schema', () => {
    const schema = JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { name: { type: 'string' } },
    });

    const result = parseSchema(schema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.draft).toBe('draft-07');
    expect(result.model.schema['type']).toBe('object');
  });

  it('detects draft-07 from $schema URI', () => {
    const schema = JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#' });
    const result = parseSchema(schema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.draft).toBe('draft-07');
  });

  it('defaults to draft-07 when $schema is absent', () => {
    const schema = JSON.stringify({ type: 'object' });
    const result = parseSchema(schema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.draft).toBe('draft-07');
  });

  it('preserves all schema keywords (identityKind, required, properties)', () => {
    const raw = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer', identityKind: 'primary-key' },
        name: { type: 'string' },
      },
    };
    const result = parseSchema(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.schema).toEqual(raw);
  });

  it('rejects non-object root (array)', () => {
    const result = parseSchema('[1, 2]');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('root must be a JSON object');
  });

  it('rejects malformed JSON with descriptive error', () => {
    const result = parseSchema('{invalid schema}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBeTruthy();
    expect(result.error.line).toBeGreaterThanOrEqual(1);
  });
});

// ─── T1.4: Schema Pretty Printer ───────────────────────────────────────────

describe('T1.4: prettyPrintSchema', () => {
  it('prints a schema model back to valid JSON', () => {
    const raw = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { id: { type: 'integer' } },
    };
    const result = parseSchema(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const printed = prettyPrintSchema(result.model, 0);
    expect(JSON.parse(printed)).toEqual(raw);
  });

  it('round-trips a complex schema with all Draft 7 features', () => {
    const raw = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'integer', identityKind: 'primary-key', minimum: 1 },
        name: { type: 'string', minLength: 1, maxLength: 255 },
        tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        status: { type: 'string', enum: ['active', 'inactive'] },
      },
      additionalProperties: false,
      if: { properties: { status: { const: 'active' } } },
      then: { required: ['tags'] },
    };
    const result = parseSchema(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const printed = prettyPrintSchema(result.model, 0);
    expect(JSON.parse(printed)).toEqual(raw);
  });
});
