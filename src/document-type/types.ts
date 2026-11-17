/**
 * Document_Type Registry types (T4.1–T4.7)
 *
 * Defines the Document_Type configuration, registry interface, and
 * related data structures.
 *
 * Design reference: design.md § Document_Type Registry
 * Validates: Requirement 46
 */

import type { DocumentModel } from '../storage/types.js';
import type { SchemaRef } from '../schema/types.js';

// ─── Document_Type Configuration ────────────────────────────────────────────

export interface DocumentTypeConfig {
  /** Unique Document_Type name (identifier). */
  readonly name: string;
  /** Exactly one Master_Schema reference. */
  masterSchema: SchemaRef;
  /** Document model (DCM, HDOM, DOM). */
  model: DocumentModel;
  /** Optional Document_Type-level TTL (seconds or 'infinite'). */
  ttl?: number | 'infinite';
  /** Channel IDs registered under this Document_Type. Managed by Channel Resolver. */
  channels: string[];
  /** Timestamp of creation. */
  readonly createdAt: string;
  /** Timestamp of last modification (= createdAt on creation). */
  updatedAt: string;
}

// ─── Registration & Update ──────────────────────────────────────────────────

export interface RegisterDocumentTypeOptions {
  readonly name: string;
  readonly masterSchema: SchemaRef;
  readonly model: DocumentModel;
  readonly ttl?: number | 'infinite';
}

export interface UpdateDocumentTypeOptions {
  readonly masterSchema?: SchemaRef;
  readonly model?: DocumentModel;
  readonly ttl?: number | 'infinite' | null; // null = remove TTL
}

// ─── Operation Results ──────────────────────────────────────────────────────

export interface DocTypeSuccess {
  readonly success: true;
  readonly config: DocumentTypeConfig;
}

export interface DocTypeError {
  readonly success: false;
  readonly code: string;
  readonly message: string;
}

export type DocTypeResult = DocTypeSuccess | DocTypeError;

export interface DocTypeDeleteResult {
  readonly success: boolean;
  readonly code?: string;
  readonly message?: string;
}

// ─── Document_Type Registry Interface ───────────────────────────────────────

export interface DocumentTypeRegistry {
  /**
   * Register a new Document_Type (T4.1).
   */
  register(options: RegisterDocumentTypeOptions): DocTypeResult;

  /**
   * Get a Document_Type by name (T4.2).
   */
  get(name: string): DocumentTypeConfig | undefined;

  /**
   * List all registered Document_Types (T4.2).
   */
  list(): DocumentTypeConfig[];

  /**
   * Update a Document_Type (T4.3).
   */
  update(name: string, updates: UpdateDocumentTypeOptions): DocTypeResult;

  /**
   * Delete a Document_Type (T4.4).
   * Rejects if documents of that type exist.
   */
  delete(name: string): DocTypeDeleteResult;

  /**
   * Check if a schema ref is used as a Master_Schema by any Document_Type.
   * Used by Schema Manager's decommission protection (T3.6).
   */
  isMasterSchema(ref: SchemaRef): boolean;

  /**
   * Add a channel ID to a Document_Type's channel list (T4.7).
   * Called by Channel Resolver on channel registration.
   */
  addChannel(documentType: string, channelId: string): boolean;

  /**
   * Remove a channel ID from a Document_Type's channel list (T4.7).
   * Called by Channel Resolver on channel deletion.
   */
  removeChannel(documentType: string, channelId: string): boolean;

  /**
   * Set the document existence checker callback.
   * The Document Manager (C8) provides this to enable deletion precondition checks.
   */
  setDocumentExistenceChecker(checker: (documentType: string) => boolean): void;
}
