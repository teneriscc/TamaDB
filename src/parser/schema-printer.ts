/**
 * JSON Schema Pretty Printer (T1.4)
 *
 * Converts the internal ValidationModel back into a JSON Schema string.
 * Guarantees round-trip fidelity: parseSchema(prettyPrint(parseSchema(x))) == parseSchema(x).
 *
 * Design reference: design.md § JSON Parser
 * Validates: Requirements 24.4, 24.5
 */

import type { ValidationModel } from './types.js';

/**
 * Convert a ValidationModel back into a JSON Schema string.
 *
 * The ValidationModel preserves the raw schema object exactly as parsed,
 * so this is a straightforward JSON.stringify with optional formatting.
 *
 * @param model - The internal ValidationModel
 * @param indent - Number of spaces for pretty-printing (0 for compact)
 * @returns A valid JSON Schema string
 */
export function prettyPrintSchema(model: ValidationModel, indent: number = 2): string {
  return JSON.stringify(model.schema, null, indent > 0 ? indent : undefined);
}
