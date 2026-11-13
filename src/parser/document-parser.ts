/**
 * JSON Document Parser (T1.1, T1.7)
 *
 * Parses raw JSON strings into the internal Bunch/Leaf tree structure.
 * Provides descriptive error reporting for malformed JSON including
 * position, line, column, and expected token information.
 *
 * Design reference: design.md § JSON Parser
 * Validates: Requirements 25.1, 25.2, 25.3
 */

import type {
  Bunch,
  JsonValue,
  Leaf,
  LeafValue,
  ParseErrorDetail,
  ParseResult,
  ParseSuccess,
  TreeNode,
} from './types.js';

/**
 * Parse a raw JSON string into the internal Bunch/Leaf tree structure.
 *
 * The root of a TamaDB document is always a Bunch (JSON object). If the
 * input parses as a non-object value, it is rejected since TamaDB documents
 * are always JSON objects per the spec.
 *
 * @param json - The raw JSON string to parse
 * @returns ParseSuccess with the tree, or ParseError with details
 */
export function parseDocument(json: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: buildParseError(json, err) };
  }

  // TamaDB documents must be JSON objects at the root level.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        message: 'Document root must be a JSON object',
        position: 0,
        line: 1,
        column: 1,
        expected: 'object',
      },
    };
  }

  const tree = objectToBunch(parsed as Record<string, unknown>);
  return { ok: true, tree } satisfies ParseSuccess;
}

/**
 * Convert a plain JavaScript object into a Bunch node.
 */
function objectToBunch(obj: Record<string, unknown>): Bunch {
  const children = new Map<string, TreeNode>();

  for (const [key, val] of Object.entries(obj)) {
    children.set(key, valueToNode(val));
  }

  return { kind: 'bunch', children };
}

/**
 * Convert any JSON value into the appropriate tree node.
 *
 * Objects → Bunch (recursive)
 * Arrays, primitives, null → Leaf (arrays are atomic per spec)
 */
function valueToNode(val: unknown): TreeNode {
  // null is a leaf
  if (val === null) {
    return { kind: 'leaf', value: null } satisfies Leaf;
  }

  // Arrays are atomic leaf values (no element-level addressing)
  if (Array.isArray(val)) {
    return { kind: 'leaf', value: val as LeafValue } satisfies Leaf;
  }

  // Objects become Bunches
  if (typeof val === 'object') {
    return objectToBunch(val as Record<string, unknown>);
  }

  // Primitives: string, number, boolean
  return { kind: 'leaf', value: val as LeafValue } satisfies Leaf;
}

/**
 * Build a descriptive ParseErrorDetail from a caught JSON.parse error.
 *
 * Extracts position information from the native SyntaxError when available,
 * and computes line/column from the source string.
 */
function buildParseError(json: string, err: unknown): ParseErrorDetail {
  const message = err instanceof SyntaxError ? err.message : 'Unknown parse error';

  // Most engines include position in the error message.
  // V8 format: "Unexpected token X in JSON at position N"
  // or: "Expected ',' or '}' after property value in JSON at position N"
  const positionMatch = message.match(/at position (\d+)/);
  const position = positionMatch ? Number.parseInt(positionMatch[1]!, 10) : 0;

  const { line, column } = offsetToLineColumn(json, position);

  // Extract expected token hint from the message when available.
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
 * Try to extract an "expected" hint from V8's SyntaxError messages.
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

/**
 * Type guard: checks if a LeafValue is a JSON array.
 */
export function isArrayLeaf(value: LeafValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
