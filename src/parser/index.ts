/**
 * JSON Parser module — public API (Component 1)
 *
 * Exports the parser and printer functions for both documents and schemas.
 * This is the entry point other components use to access C1 functionality.
 *
 * Design reference: design.md § JSON Parser
 */

export { parseDocument, isArrayLeaf } from './document-parser.js';
export { prettyPrintDocument, treeNodeToJsonValue } from './document-printer.js';
export { parseSchema } from './schema-parser.js';
export { prettyPrintSchema } from './schema-printer.js';
export type {
  Bunch,
  JsonSchemaObject,
  JsonValue,
  Leaf,
  LeafValue,
  ParseError,
  ParseErrorDetail,
  ParseResult,
  ParseSuccess,
  SchemaParseError,
  SchemaParseResult,
  SchemaParseSuccess,
  TreeNode,
  ValidationModel,
} from './types.js';
