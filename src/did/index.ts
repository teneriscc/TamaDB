/**
 * D-Id module — public API (Component 6)
 *
 * Exports the D-Id Extractor implementation and associated types.
 */

export { DIdExtractorImpl } from './did-extractor.js';
export type {
  DefinitionError,
  DefinitionResult,
  DefinitionSuccess,
  DIdDefinition,
  DIdExtractor,
  ExtractionError,
  ExtractionResult,
  ExtractionSuccess,
  IdentityField,
  IdentityKind,
  RegistrationWarning,
  WarningCode,
} from './types.js';
