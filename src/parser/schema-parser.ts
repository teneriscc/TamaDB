/**
 * JSON Schema Parser (T1.3, T1.7)
 *
 * Parses raw JSON Schema (Draft 7) strings into the internal ValidationModel.
 * The ValidationModel preserves the schema exactly for round-trip fidelity.
 * Semantic interpretation and compilation (via Ajv) is handled by the
 * Schema Manager (C3).
 *
 * Design reference: design.md § JSON Parser
 * Validates: Requirements 24.1, 24.2, 24.3
 */

import type {
  JsonSchemaObject,
  ParseErrorDetail,
  SchemaParseResult,
} from './types.js';

/** Known JSON Schema draft identifiers and their canonical URIs. */
const DRAFT_MAP: ReadonlyMap<string, string> = new Map([
  ['http://json-schema.org/draft-07/schema#', 'draft-07'],
  ['http://json-schema.org/draft-07/schema', 'draft-07'],
  ['http://json-schema.org/draft-06/schema#', 'draft-06'],
  ['http://json-schema.org/draft-04/schema#', 'draft-04'],
]);

const DEFAULT_DRAFT = 'draft-07';

/**
 * Parse a raw JSON Schema string into the internal ValidationModel.
 *
 * This performs structural parsing only (valid JSON, is an object).
 * Schema semantic validation (correct use of keywords, type constraints, etc.)
 * is deferred to the Schema Manager (C3) which uses Ajv for compilation.
 *
 * @param json - Raw JSON Schema string
 * @returns SchemaParseResult — success with ValidationModel, or error with details
 */
export function parseSchema(json: string): SchemaParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: buildSchemaParseError(json, err) };
  }

  // JSON Schema must be a JSON object at the root level.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        message: 'JSON Schema root must be a JSON object',
        position: 0,
        line: 1,
        column: 1,
        expected: 'object',
      },
    };
  }

  const schema = parsed as JsonSchemaObject;
  const draft = detectDraft(schema);

  return {
    ok: true,
    model: { schema, draft },
  };
}

/**
 * Detect the JSON Schema draft version from the $schema keyword.
 * Falls back to draft-07 (TamaDB's target) if not specified.
 */
function detectDraft(schema: JsonSchemaObject): string {
  const schemaUri = schema['$schema'];
  if (typeof schemaUri === 'string') {
    return DRAFT_MAP.get(schemaUri) ?? DEFAULT_DRAFT;
  }
  return DEFAULT_DRAFT;
}

/**
 * Build a descriptive error from a JSON.parse failure on schema input.
 */
function buildSchemaParseError(json: string, err: unknown): ParseErrorDetail {
  const message = err instanceof SyntaxError ? err.message : 'Unknown parse error';

  const positionMatch = message.match(/at position (\d+)/);
  const position = positionMatch ? Number.parseInt(positionMatch[1]!, 10) : 0;

  const { line, column } = offsetToLineColumn(json, position);

  const expectedMatch = message.match(/Expected (.+?) in JSON/i);
  const expected = expectedMatch ? expectedMatch[1] : extractExpectedFromMessage(message);

  const base = { message, position, line, column };
  return expected !== undefined ? { ...base, expected } : base;
}

/**
 * Convert a byte offset into 1-based line and column numbers.
 */
function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;

  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }

  const column = offset - lastNewline;
  return { line, column };
}

/**
 * Extract expected hint from error message.
 */
function extractExpectedFromMessage(message: string): string | undefined {
  if (message.includes('Unexpected end of JSON')) {
    return 'value or closing delimiter';
  }
  if (message.includes('Unexpected token')) {
    return 'valid JSON token';
  }
  return undefined;
}
