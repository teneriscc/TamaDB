/**
 * Query Engine implementation (T9.1–T9.12)
 *
 * Provides document retrieval, glob matching, path-based access,
 * schema-based filtering, and value search.
 *
 * Design reference: design.md § Query Engine
 * Validates: Requirements 8, 9, 10, 11, 13, 14, 15
 */

import type { DocumentIdentifier, InternalDocument, StorageAdapter, StoredBunch, StoredLeaf } from '../storage/types.js';
import type {
  MultiRetrievalResult,
  NotFoundReason,
  OnAccessPersist,
  QueryEngine,
  RetrievalOptions,
  RetrievalResult,
  RetrievalSuccess,
  SearchResult,
  TtlCheckResult,
  TtlChecker,
} from './types.js';

export class QueryEngineImpl implements QueryEngine {
  private readonly storage: StorageAdapter;
  private ttlChecker: TtlChecker | undefined;
  private onAccessPersist: OnAccessPersist | undefined;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  setTtlChecker(checker: TtlChecker): void {
    this.ttlChecker = checker;
  }

  setOnAccessPersist(persist: OnAccessPersist): void {
    this.onAccessPersist = persist;
  }

  // ─── T9.1: Full Document Retrieval ─────────────────────────────────────

  retrieveDocument(documentType: string, dId: DocumentIdentifier, options?: RetrievalOptions): RetrievalResult {
    const doc = this.storage.retrieve(documentType, dId);
    if (!doc) {
      return { success: false, code: 'DOCUMENT_NOT_FOUND', message: 'Document not found', reason: null };
    }

    // T9.12 / T9.11: Soft-delete + on-access TTL check (Best-Effort Read model).
    //
    // A TTL-driven soft-deleted document that is still salvageable (TTL > 0, no
    // Expire-at-Point-in-Time) is served as a Best-Effort Read (Req 32.8/32.8a):
    // returned in place WITHOUT clearing its soft-delete state, restoring it to
    // the live set, or resetting its TTL. Every other soft-delete type (and TTL=0)
    // is permanently excluded.
    if (doc.softDeleted) {
      if (doc.softDeleteType === 'ttl_expired' && this.isSalvageable(doc)) {
        // Best-Effort Read: serve in place, no state change, no persistence.
        return this.renderRetrieval(doc, options);
      }
      return {
        success: false,
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document has been deleted',
        reason: this.softDeleteReason(doc),
      };
    }

    // On-access TTL check for a live (not-yet-swept) document (Req 37b.4/37b.6).
    const ttlResult = this.checkTtl(doc);
    if (ttlResult && !ttlResult.valid) {
      // Live but past a NON-salvageable expiry (Expire-At, or TTL=0): perform
      // the TTL-driven soft-delete now (safety net) so persisted state matches
      // the not-found result, then return not-found with the correct reason.
      const reason = ttlResult.reason ?? 'ttl-expired';
      this.onAccessPersist?.(documentType, dId, reason);
      return {
        success: false,
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document expired',
        reason,
      };
    }
    // Live but past a SALVAGEABLE expiry, not yet swept: served in place as a
    // Best-Effort Read (checkTtl returns valid with action 'serve'); no state
    // change. Falls through to normal rendering below.

    return this.renderRetrieval(doc, options);
  }

  /** Render a servable (live, or salvageable Best-Effort Read) document for a retrieval result. */
  private renderRetrieval(doc: InternalDocument, options?: RetrievalOptions): RetrievalResult {
    // Path-based retrieval (T9.3, T9.4)
    if (options?.path) {
      return this.retrieveByPath(doc, options.path);
    }
    // Full document rendering
    const rendered = this.renderDocument(doc, options);
    return {
      success: true,
      document: rendered,
      dId: doc.dId,
      documentType: doc.documentType,
    };
  }

  // ─── T9.2: Glob Pattern Matching ──────────────────────────────────────

  retrieveByGlob(documentType: string, pattern: DocumentIdentifier): MultiRetrievalResult {
    const allDIds = this.storage.listByDocumentType(documentType);
    const matched: RetrievalSuccess[] = [];

    for (const dId of allDIds) {
      if (this.matchesGlob(dId, pattern)) {
        const result = this.retrieveDocument(documentType, dId);
        if (result.success) {
          matched.push(result);
        }
      }
    }

    return { success: true, documents: matched };
  }

  // ─── T9.3: Leaf Retrieval by Path ─────────────────────────────────────

  retrieveLeaf(documentType: string, dId: DocumentIdentifier, path: string): RetrievalResult {
    return this.retrieveDocument(documentType, dId, { path });
  }

  // ─── T9.4: Bunch Retrieval by Path ────────────────────────────────────

  retrieveBunch(documentType: string, dId: DocumentIdentifier, path: string): RetrievalResult {
    return this.retrieveDocument(documentType, dId, { path });
  }

  // ─── T9.8: Value-Based Search ─────────────────────────────────────────

  searchByValue(documentType: string, fieldPath: string, value: unknown, includeExpired = true): SearchResult {
    const allDIds = this.storage.listByDocumentType(documentType);
    const matches: RetrievalSuccess[] = [];

    for (const dId of allDIds) {
      const doc = this.storage.retrieve(documentType, dId);
      if (!doc) continue;

      // Req 15.6–15.8 + 37b.6: value-search expiry visibility.
      if (doc.softDeleted) {
        // Already soft-deleted: only TTL-driven salvageable deletes may be
        // surfaced, and only when includeExpired is true. All non-salvageable
        // types (explicit, system_override, absolute_expired, TTL=0) are NEVER
        // surfaced.
        if (!includeExpired) continue;
        if (doc.softDeleteType !== 'ttl_expired' || !this.isSalvageable(doc)) continue;
        // Req 15.7: surfacing is visibility-only — no state change, no TTL
        // change. The doc remains soft-deleted and sweep-eligible.
      } else {
        // Live (not-yet-swept) document: apply the on-access TTL check so the
        // sweep-timing guarantee (Req 37b.6) holds for search too. A live doc
        // past a non-salvageable expiry (Expire-At or TTL=0) is excluded
        // regardless of includeExpired; a live doc past a salvageable TTL is
        // surfaced only when includeExpired is true (visibility-only, no persist).
        const ttlResult = this.checkTtl(doc);
        if (ttlResult && !ttlResult.valid) {
          continue; // expired, non-salvageable → never surfaced
        }
        if (ttlResult && ttlResult.valid && ttlResult.action === 'serve') {
          // expired-but-salvageable (Best-Effort Read)
          if (!includeExpired) continue;
        }
      }

      const leafValue = this.getLeafValueByPath(doc.root, fieldPath);
      if (leafValue !== undefined && this.valuesMatch(leafValue, value)) {
        const rendered = this.renderDocument(doc);
        matches.push({
          success: true,
          document: rendered,
          dId: doc.dId,
          documentType: doc.documentType,
        });
      }
    }

    return { success: true, matches };
  }

  /**
   * Whether an expired document is salvageable (Req 32.7 / 32.8a): the on-access
   * TTL check confirms effective TTL > 0 AND no Expire-at-Point-in-Time policy,
   * so it may be served as a Best-Effort Read. Classification only — never
   * mutates state. Returns false when no ttlChecker is wired.
   */
  private isSalvageable(doc: InternalDocument): boolean {
    if (!this.ttlChecker) return false;
    const result = this.ttlChecker(doc);
    return result.valid && result.action === 'serve';
  }

  // ─── Private: Path-based retrieval ─────────────────────────────────────

  private retrieveByPath(doc: InternalDocument, path: string): RetrievalResult {
    const parts = path.split('.');
    let current: StoredBunch | StoredLeaf = doc.root;

    for (const part of parts) {
      if (!('children' in current)) {
        return {
          success: false,
          code: 'INVALID_PATH',
          message: `Path '${path}' is invalid: '${part}' is not a bunch`,
          reason: null,
        };
      }

      const child = current.children.get(part);
      if (!child) {
        return {
          success: false,
          code: 'INVALID_PATH',
          message: `Path '${path}' is invalid: '${part}' not found`,
          reason: null,
        };
      }

      current = child;
    }

    // Render the resolved node
    const rendered = this.renderNode(current);
    return {
      success: true,
      document: typeof rendered === 'object' && rendered !== null && !Array.isArray(rendered)
        ? rendered as Record<string, unknown>
        : { _value: rendered },
      dId: doc.dId,
      documentType: doc.documentType,
    };
  }

  // ─── Private: Glob matching ────────────────────────────────────────────

  private matchesGlob(dId: DocumentIdentifier, pattern: DocumentIdentifier): boolean {
    if (dId.type === 'single' && pattern.type === 'single') {
      return this.globMatch(dId.value, pattern.value);
    }

    if (dId.type === 'composed' && pattern.type === 'composed') {
      if (dId.parts.length !== pattern.parts.length) return false;
      return dId.parts.every((part, idx) => this.globMatch(part, pattern.parts[idx]!));
    }

    return false;
  }

  /**
   * Simple glob matching: * matches any sequence, ? matches single char.
   */
  private globMatch(text: string, pattern: string): boolean {
    let ti = 0;
    let pi = 0;
    let starTi = -1;
    let starPi = -1;

    while (ti < text.length) {
      if (pi < pattern.length && (pattern[pi] === text[ti] || pattern[pi] === '?')) {
        ti++;
        pi++;
      } else if (pi < pattern.length && pattern[pi] === '*') {
        starTi = ti;
        starPi = pi;
        pi++;
      } else if (starPi !== -1) {
        pi = starPi + 1;
        starTi++;
        ti = starTi;
      } else {
        return false;
      }
    }

    while (pi < pattern.length && pattern[pi] === '*') {
      pi++;
    }

    return pi === pattern.length;
  }

  // ─── Private: Document rendering ───────────────────────────────────────

  private renderDocument(doc: InternalDocument, options?: RetrievalOptions): Record<string, unknown> {
    const full = this.renderBunch(doc.root);

    // T9.5–T9.7: Retrieval mode filtering
    const mode = options?.mode ?? 'full';
    if (mode === 'full' || !options?.retrievalSchema) {
      return full;
    }

    const schemaProperties = (options.retrievalSchema['properties'] ?? {}) as Record<string, unknown>;
    const schemaFields = new Set(Object.keys(schemaProperties));

    if (mode === 'closed') {
      // Return only schema-specified fields
      const filtered: Record<string, unknown> = {};
      for (const key of schemaFields) {
        if (key in full) {
          filtered[key] = full[key];
        }
      }
      return filtered;
    }

    // mode === 'open': schema fields + extensions (all fields)
    return full;
  }

  private renderBunch(bunch: StoredBunch): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, child] of bunch.children) {
      result[key] = this.renderNode(child);
    }
    return result;
  }

  private renderNode(node: StoredBunch | StoredLeaf): unknown {
    if ('children' in node) {
      return this.renderBunch(node);
    }
    return node.value;
  }

  // ─── Private: Value access by path ─────────────────────────────────────

  private getLeafValueByPath(bunch: StoredBunch, path: string): unknown | undefined {
    const parts = path.split('.');
    let current: StoredBunch | StoredLeaf = bunch;

    for (const part of parts) {
      if (!('children' in current)) return undefined;
      const child = current.children.get(part);
      if (!child) return undefined;
      current = child;
    }

    if ('value' in current) {
      return current.value;
    }
    return undefined;
  }

  private valuesMatch(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // ─── Private: TTL check ────────────────────────────────────────────────

  private checkTtl(doc: InternalDocument): TtlCheckResult | undefined {
    if (!this.ttlChecker) return undefined;
    return this.ttlChecker(doc);
  }

  // ─── Private: Soft delete reason ───────────────────────────────────────

  private softDeleteReason(doc: InternalDocument): NotFoundReason {
    switch (doc.softDeleteType) {
      case 'explicit': return 'explicit-soft-deleted';
      case 'ttl_expired': return 'ttl-expired';
      case 'absolute_expired': return 'absolute-expired';
      case 'system_override': return 'system-override';
      default: return null;
    }
  }
}
