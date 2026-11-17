/**
 * Document_Type Registry implementation (T4.1–T4.7)
 *
 * Manages Document_Type definitions: registration, retrieval, update,
 * deletion, channel list maintenance, and Master_Schema invariant.
 *
 * Design reference: design.md § Document_Type Registry
 * Validates: Requirement 46
 */

import type { SchemaRef } from '../schema/types.js';
import type {
  DocTypeDeleteResult,
  DocTypeResult,
  DocumentTypeConfig,
  DocumentTypeRegistry,
  RegisterDocumentTypeOptions,
  UpdateDocumentTypeOptions,
} from './types.js';

export class DocumentTypeRegistryImpl implements DocumentTypeRegistry {
  /** Registry: name → Document_Type config. */
  private readonly types = new Map<string, DocumentTypeConfig>();

  /**
   * External checker for deletion precondition (T4.4).
   * Provided by Document Manager (C8) to check if documents of a type exist.
   */
  private documentExistenceChecker: ((documentType: string) => boolean) | undefined;

  // ─── T4.1: Registration ─────────────────────────────────────────────────

  register(options: RegisterDocumentTypeOptions): DocTypeResult {
    const { name, masterSchema, model, ttl } = options;

    if (this.types.has(name)) {
      return { success: false, code: 'DOCUMENT_TYPE_ALREADY_EXISTS', message: `Document_Type '${name}' already exists` };
    }

    if (!name || name.trim().length === 0) {
      return { success: false, code: 'INVALID_NAME', message: 'Document_Type name must be non-empty' };
    }

    // T4.5: createdAt = updatedAt on creation
    const now = new Date().toISOString();
    const config: DocumentTypeConfig = {
      name,
      masterSchema,
      model,
      ...(ttl !== undefined ? { ttl } : {}),
      channels: [],
      createdAt: now,
      updatedAt: now,
    };

    this.types.set(name, config);
    return { success: true, config };
  }

  // ─── T4.2: Retrieval ────────────────────────────────────────────────────

  get(name: string): DocumentTypeConfig | undefined {
    return this.types.get(name);
  }

  list(): DocumentTypeConfig[] {
    return [...this.types.values()];
  }

  // ─── T4.3: Update ──────────────────────────────────────────────────────

  update(name: string, updates: UpdateDocumentTypeOptions): DocTypeResult {
    const config = this.types.get(name);
    if (!config) {
      return { success: false, code: 'DOCUMENT_TYPE_NOT_FOUND', message: `Document_Type '${name}' not found` };
    }

    // T4.6: Master_Schema change (one schema per type invariant preserved)
    if (updates.masterSchema !== undefined) {
      config.masterSchema = updates.masterSchema;
    }

    if (updates.model !== undefined) {
      config.model = updates.model;
    }

    // TTL: null means remove, undefined means no change
    if (updates.ttl === null) {
      delete config.ttl;
    } else if (updates.ttl !== undefined) {
      config.ttl = updates.ttl;
    }

    // T4.5: updatedAt changes on any modification
    config.updatedAt = new Date().toISOString();

    return { success: true, config };
  }

  // ─── T4.4: Deletion ────────────────────────────────────────────────────

  delete(name: string): DocTypeDeleteResult {
    const config = this.types.get(name);
    if (!config) {
      return { success: false, code: 'DOCUMENT_TYPE_NOT_FOUND', message: `Document_Type '${name}' not found` };
    }

    // Precondition: no documents of this type exist (Req 46.12)
    if (this.documentExistenceChecker && this.documentExistenceChecker(name)) {
      return {
        success: false,
        code: 'DOCUMENTS_EXIST',
        message: `Cannot delete Document_Type '${name}': documents of this type still exist`,
      };
    }

    this.types.delete(name);
    return { success: true };
  }

  // ─── T4.6: Master_Schema invariant check ────────────────────────────────

  /**
   * Check if a schema ref is used as a Master_Schema by any registered Document_Type.
   * Used by Schema Manager's decommission protection.
   */
  isMasterSchema(ref: SchemaRef): boolean {
    for (const config of this.types.values()) {
      if (config.masterSchema === ref) {
        return true;
      }
    }
    return false;
  }

  // ─── T4.7: Channel list maintenance ─────────────────────────────────────

  addChannel(documentType: string, channelId: string): boolean {
    const config = this.types.get(documentType);
    if (!config) return false;

    if (!config.channels.includes(channelId)) {
      config.channels.push(channelId);
      config.updatedAt = new Date().toISOString();
    }
    return true;
  }

  removeChannel(documentType: string, channelId: string): boolean {
    const config = this.types.get(documentType);
    if (!config) return false;

    const idx = config.channels.indexOf(channelId);
    if (idx === -1) return false;

    config.channels.splice(idx, 1);
    config.updatedAt = new Date().toISOString();
    return true;
  }

  // ─── Dependency injection ───────────────────────────────────────────────

  setDocumentExistenceChecker(checker: (documentType: string) => boolean): void {
    this.documentExistenceChecker = checker;
  }

  // ─── Persistence: Restore ───────────────────────────────────────────────

  /**
   * Restore a Document_Type entry from a persisted snapshot.
   */
  restoreEntry(entry: { name: string; masterSchema: string; model: 'closed' | 'hybrid' | 'open'; ttl?: number | 'infinite'; channels: string[]; createdAt: string; updatedAt: string }): void {
    const config: DocumentTypeConfig = {
      name: entry.name,
      masterSchema: entry.masterSchema,
      model: entry.model,
      ...(entry.ttl !== undefined ? { ttl: entry.ttl } : {}),
      channels: [...entry.channels],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    this.types.set(entry.name, config);
  }
}
