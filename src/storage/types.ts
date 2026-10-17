/**
 * Storage Adapter types and interfaces (T2.1)
 *
 * Defines the storage abstraction boundary between TamaDB's domain engine
 * and the underlying persistence mechanism. All domain logic above this
 * interface is persistence-agnostic.
 *
 * Design reference: design.md § Storage Adapter, § Storage Layer Architecture
 * Validates: Requirement 22
 */


// ─── Document Identifier (re-exported from design.md data models) ───────────

export interface SingleKey {
  readonly type: 'single';
  readonly value: string;
}

export interface ComposedKey {
  readonly type: 'composed';
  readonly parts: readonly string[];
}

export type DocumentIdentifier = SingleKey | ComposedKey;

// ─── Storage Strategy ───────────────────────────────────────────────────────

export type StorageStrategyMode = 'auto' | 'memory' | 'disk' | 'hybrid';

// ─── Timestamp & Version (structural types used by stored documents) ────────

export interface Timestamp {
  /** Request receipt time (t1) — used for versioning and history ordering. */
  readonly requestTime: string;
  /** Write completion time (t1+m) — stored for auditability only. */
  readonly commitTime: string;
  /** Ingestion channel identifier. */
  readonly channelIdentifier: string;
}

export interface TimestampReference {
  /** Position (0-based index) in the document's timestamp list. */
  readonly index: number;
}

// ─── Leaf & Bunch Metadata (stored forms with version tracking) ─────────────

export interface LeafMetadata {
  readonly timestampRef: TimestampReference;
  readonly versionNo: number;
}

export interface HistoryEntry {
  readonly value: unknown;
  readonly timestampRef: TimestampReference;
}

export interface StoredLeaf {
  readonly value: unknown;
  readonly metadata: LeafMetadata;
  readonly history: readonly HistoryEntry[];
}

export interface BunchMetadata {
  readonly timestampRef: TimestampReference;
  readonly versionNo: number;
  readonly history: readonly TimestampReference[];
}

export interface StoredBunch {
  readonly metadata: BunchMetadata;
  readonly children: Map<string, StoredBunch | StoredLeaf>;
}

// ─── Document Models ────────────────────────────────────────────────────────

export type DocumentModel = 'closed' | 'hybrid' | 'open';

// ─── Soft Delete ────────────────────────────────────────────────────────────

export type SoftDeleteType = 'explicit' | 'ttl_expired' | 'system_override' | 'absolute_expired';

// ─── Internal Document (the full stored representation) ─────────────────────

export interface InternalDocument {
  readonly dId: DocumentIdentifier;
  readonly documentType: string;
  /**
   * Immutable document creation instant (ISO string). Set once at creation
   * (from the first timestampList entry) and carried through merges unchanged.
   *
   * As of 0.4.0 this is NO LONGER the TTL anchor: TTL is a sliding window
   * anchored to the document's LAST UPDATE time (`lastUpdateTime +
   * effectiveTTL`, re-armed on every store — see Req 37.3b/37b.5a). creationTime
   * is retained for (a) audit, and (b) a future configurable
   * `ttlAnchor: 'update' | 'creation'` mode (DCM defaults to 'update'; HDOM/DOM
   * owners may later prefer 'creation' to cap growth — deferred, see
   * requirements Future Considerations). Keep it populated so the anchor is not
   * hardcoded to 'update' forever.
   */
  readonly creationTime: string;
  readonly timestampList: Timestamp[];
  readonly versionNo: number;
  readonly historyDepth: number;
  readonly model: DocumentModel;
  readonly root: StoredBunch;
  readonly softDeleted: boolean;
  readonly softDeleteType?: SoftDeleteType;
  readonly softDeleteTimestamp?: Timestamp;
  readonly ttl?: number | 'infinite';
  readonly expireAt?: string;
}

// ─── Storage Key ────────────────────────────────────────────────────────────

/**
 * Serialise a (documentType, dId) pair into a string key for storage lookup.
 * Identity is scoped to (Document_Type, D-Id) per Requirement 1.7.
 */
export function storageKey(documentType: string, dId: DocumentIdentifier): string {
  const idPart = dId.type === 'single' ? dId.value : dId.parts.join('\x00');
  return `${documentType}\x01${idPart}`;
}

// ─── Storage Adapter Interface ──────────────────────────────────────────────

/**
 * The StorageAdapter interface — the abstraction boundary between TamaDB's
 * domain engine and the persistence layer.
 *
 * All methods operate on full InternalDocument instances. The domain layer
 * (Document Manager, Version Manager, etc.) is responsible for constructing
 * and updating the document structure before calling storage.
 */
export interface StorageAdapter {
  /**
   * Store (create or overwrite) a document.
   * The caller is responsible for merge semantics — storage is a dumb put.
   */
  store(documentType: string, dId: DocumentIdentifier, document: InternalDocument): void;

  /**
   * Retrieve a document by (documentType, dId). Returns undefined if not found.
   */
  retrieve(documentType: string, dId: DocumentIdentifier): InternalDocument | undefined;

  /**
   * Delete a document from storage entirely. Used for hard eviction
   * (e.g., after TTL sweep of soft-deleted documents).
   */
  delete(documentType: string, dId: DocumentIdentifier): boolean;

  /**
   * Check if a document exists without retrieving the full payload.
   */
  has(documentType: string, dId: DocumentIdentifier): boolean;

  /**
   * List all document identifiers for a given Document_Type.
   * Used for glob pattern matching and sweep operations.
   */
  listByDocumentType(documentType: string): DocumentIdentifier[];

  /**
   * Return the total number of documents in storage.
   */
  count(): number;

  /**
   * Clear all stored documents. Used for testing and instance reset.
   */
  clear(): void;
}
