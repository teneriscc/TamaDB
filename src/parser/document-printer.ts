/**
 * JSON Document Pretty Printer (T1.2)
 *
 * Converts the internal Bunch/Leaf tree structure back into a JSON string.
 * Guarantees round-trip fidelity: parse(prettyPrint(parse(x))) == parse(x).
 *
 * Design reference: design.md § JSON Parser
 * Validates: Requirements 25.4, 25.5
 */

import type { Bunch, JsonValue, Leaf, LeafValue, TreeNode } from './types.js';

/**
 * Convert a Bunch (document root) back into a JSON string.
 *
 * @param tree - The root Bunch of the parsed document tree
 * @param indent - Number of spaces for pretty-printing (0 for compact)
 * @returns A valid JSON string representation
 */
export function prettyPrintDocument(tree: Bunch, indent: number = 2): string {
  const obj = bunchToObject(tree);
  return JSON.stringify(obj, null, indent > 0 ? indent : undefined);
}

/**
 * Convert a Bunch node back into a plain JavaScript object.
 * Uses Object.defineProperty to correctly handle keys like "__proto__".
 */
function bunchToObject(bunch: Bunch): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;

  for (const [key, node] of bunch.children) {
    Object.defineProperty(result, key, {
      value: nodeToValue(node),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  return result;
}

/**
 * Convert a tree node back into its original JSON value.
 */
function nodeToValue(node: TreeNode): unknown {
  if (node.kind === 'leaf') {
    return leafToValue(node);
  }
  return bunchToObject(node);
}

/**
 * Convert a Leaf node back to its raw JSON value.
 */
function leafToValue(leaf: Leaf): LeafValue {
  return leaf.value;
}

/**
 * Convert any TreeNode to its equivalent JsonValue for serialisation.
 * Useful for integration with other components that work with raw JSON.
 */
export function treeNodeToJsonValue(node: TreeNode): JsonValue {
  if (node.kind === 'leaf') {
    return node.value as JsonValue;
  }

  const obj = Object.create(null) as Record<string, JsonValue>;
  for (const [key, child] of node.children) {
    Object.defineProperty(obj, key, {
      value: treeNodeToJsonValue(child),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return obj;
}
