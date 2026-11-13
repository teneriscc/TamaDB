/**
 * Document_Type module — public API (Component 4)
 *
 * Exports the Document_Type Registry implementation and associated types.
 */

export { DocumentTypeRegistryImpl } from './document-type-registry.js';
export type {
  DocTypeDeleteResult,
  DocTypeError,
  DocTypeResult,
  DocTypeSuccess,
  DocumentTypeConfig,
  DocumentTypeRegistry,
  RegisterDocumentTypeOptions,
  UpdateDocumentTypeOptions,
} from './types.js';
