/**
 * Internal tree model for TamaDB documents.
 *
 * This module defines the parsed representation of JSON documents as a tree
 * of Bunches (objects) and Leaves (terminal values). This is the "Parsed_Payload"
 * representation — structural only, no versioning metadata yet. Metadata is
 * layered on by the Version Manager (C7) during store operations.
 *
 * Design reference: design.md § Document Internal Structure, § JSON Parser
 */

/**
 * A terminal node in the document tree. Holds a JSON-primitive or array value.
 *
 * Arrays are treated as atomic leaf values (no element-level addressing).
 * This matches Requirement 6 merge semantics and the Increment 1 scope
 * boundary: "Arrays: Atomic leaf values (no element-level addressing)".
 */
export interface Leaf {
  readonly kind: 'leaf';
  /** The JSON value: string, number, boolean, null, or array (atomic). */
  readonly value: LeafValue;
}

/**
 * Allowed leaf values. Arrays are stored as atomic units (full replacement
 * on update). Objects are never leaf values — they become Bunches.
 */
export type LeafValue = string | number | boolean | null | readonly JsonValue[];

/**
 * A non-terminal node in the document tree. Contains named children
 * which are themselves Bunches or Leaves.
 *
 * Maps directly to a JSON object in the source document.
 */
export interface Bunch {
  readonly kind: 'bunch';
  /** Ordered map of child name → child node. Preserves insertion order. */
  readonly children: ReadonlyMap<string, TreeNode>;
}

/**
 * A node in the parsed document tree — either a Bunch (object) or a Leaf
 * (terminal value: primitive or array).
 */
export type TreeNode = Bunch | Leaf;

/**
 * Any JSON-compatible value. Used for array contents and general interchange.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Result of a successful parse operation.
 */
export interface ParseSuccess {
  readonly ok: true;
  readonly tree: Bunch;
}

/**
 * Result of a failed parse operation with descriptive error information.
 * Satisfies Requirement 25.2: "descriptive error indicating the syntax violation".
 */
export interface ParseError {
  readonly ok: false;
  readonly error: ParseErrorDetail;
}

/**
 * Detailed parse error information.
 * - position: byte offset in the source string where the error was detected
 * - line/column: 1-based line and column for human readability
 * - message: description of what went wrong
 * - expected: what the parser expected at this position (when determinable)
 */
export interface ParseErrorDetail {
  readonly message: string;
  readonly position: number;
  readonly line: number;
  readonly column: number;
  readonly expected?: string;
}

export type ParseResult = ParseSuccess | ParseError;

/**
 * Result of a successful schema parse operation.
 */
export interface SchemaParseSuccess {
  readonly ok: true;
  readonly model: ValidationModel;
}

/**
 * Result of a failed schema parse operation.
 */
export interface SchemaParseError {
  readonly ok: false;
  readonly error: ParseErrorDetail;
}

export type SchemaParseResult = SchemaParseSuccess | SchemaParseError;

/**
 * Internal validation model wrapping a parsed JSON Schema (Draft 7).
 *
 * In Increment 1, this is a thin wrapper around the raw schema object.
 * The Schema Manager (C3) will use Ajv to compile this into a validator.
 * The parser's job is structural parsing + round-trip fidelity, not
 * semantic validation of schema correctness.
 */
export interface ValidationModel {
  /** The raw JSON Schema object, preserved exactly for round-trip fidelity. */
  readonly schema: JsonSchemaObject;
  /** Schema draft version detected (e.g., "draft-07"). */
  readonly draft: string;
}

/**
 * A JSON Schema object. Typed loosely to accommodate all Draft 7 constructs.
 * The Schema Manager (C3) handles semantic interpretation via Ajv.
 */
export interface JsonSchemaObject {
  readonly [key: string]: JsonValue | undefined;
}
