/**
 * Storage Manager (T2.5, T2.6, T2.7)
 *
 * Manages storage strategy selection and runtime switching. Provides a
 * unified facade over the four strategy modes (AUTO, MEMORY, DISK, HYBRID).
 *
 * AUTO mode evaluates per-operation whether to use memory or disk based
 * on available system resources. Other modes bypass evaluation entirely.
 *
 * Design reference: design.md § Storage Adapter (AUTO mode evaluation logic)
 * Validates: Requirement 22.1–22.6
 */

import { freemem } from 'node:os';
import type { DocumentIdentifier, InternalDocument, StorageAdapter, StorageStrategyMode } from './types.js';
import { DiskStore } from './disk-store.js';
import { HybridStore } from './hybrid-store.js';
import { MemoryStore } from './memory-store.js';

/** Default disk directory for DISK and HYBRID strategies. */
const DEFAULT_DISK_DIR = '.tamadb-data';

export interface StorageManagerOptions {
  /** Initial strategy mode. Default: 'auto'. */
  mode?: StorageStrategyMode;
  /** Directory for disk-backed storage. Default: '.tamadb-data'. */
  diskDir?: string;
}

/**
 * StorageManager wraps the strategy pattern for storage. It implements
 * StorageAdapter itself, delegating to the active strategy.
 *
 * T2.5: AUTO strategy (per-operation evaluation)
 * T2.6: Runtime mode switching via setStrategy()
 * T2.7: Current mode exposed via getStrategy()
 */
export class StorageManager implements StorageAdapter {
  private mode: StorageStrategyMode;
  private readonly diskDir: string;

  /** The active backing stores. Memory is always available (needed for AUTO). */
  private memoryStore: MemoryStore;
  private diskStore: DiskStore;
  private hybridStore: HybridStore | undefined;

  constructor(options: StorageManagerOptions = {}) {
    this.mode = options.mode ?? 'auto';
    this.diskDir = options.diskDir ?? DEFAULT_DISK_DIR;
    this.memoryStore = new MemoryStore();
    this.diskStore = new DiskStore(this.diskDir);

    if (this.mode === 'hybrid') {
      this.hybridStore = new HybridStore(this.diskDir);
    }
  }

  // ─── T2.7: Expose current strategy mode ─────────────────────────────────

  getStrategy(): StorageStrategyMode {
    return this.mode;
  }

  // ─── Drain: flush memory to disk ────────────────────────────────────────

  /**
   * Drain all in-memory documents to disk storage. Returns the number of
   * documents written. No-op in `disk` mode (nothing in memory to drain).
   *
   * Useful for graceful shutdown or before switching away from auto/hybrid/memory.
   */
  drain(): number {
    if (this.mode === 'disk') return 0;

    let count = 0;
    const docs = (this.memoryStore as unknown as { documents: Map<string, InternalDocument> }).documents;
    for (const doc of docs.values()) {
      if (!this.diskStore.has(doc.documentType, doc.dId)) {
        this.diskStore.store(doc.documentType, doc.dId, doc);
        count++;
      } else {
        // Overwrite disk with the latest memory version
        this.diskStore.store(doc.documentType, doc.dId, doc);
        count++;
      }
    }
    return count;
  }

  // ─── T2.6: Runtime mode switching ───────────────────────────────────────

  /**
   * Switch storage strategy at runtime without restart.
   *
   * When switching TO a mode that requires data migration (e.g., memory→disk),
   * existing documents are migrated. This is a potentially expensive operation
   * for large datasets.
   */
  setStrategy(newMode: StorageStrategyMode): void {
    if (newMode === this.mode) return;

    const previousMode = this.mode;
    this.mode = newMode;

    // Initialise hybrid store if switching to hybrid
    if (newMode === 'hybrid' && !this.hybridStore) {
      this.hybridStore = new HybridStore(this.diskDir);
    }

    // Migrate data to the new strategy's backing store
    this.migrateData(previousMode, newMode);
  }

  // ─── StorageAdapter implementation (delegates to active strategy) ───────

  store(documentType: string, dId: DocumentIdentifier, document: InternalDocument): void {
    const target = this.resolveTarget(document);
    target.store(documentType, dId, document);
  }

  retrieve(documentType: string, dId: DocumentIdentifier): InternalDocument | undefined {
    // For AUTO, check memory first, then disk
    if (this.mode === 'auto') {
      return this.memoryStore.retrieve(documentType, dId)
        ?? this.diskStore.retrieve(documentType, dId);
    }
    return this.activeStore().retrieve(documentType, dId);
  }

  delete(documentType: string, dId: DocumentIdentifier): boolean {
    if (this.mode === 'auto') {
      const memResult = this.memoryStore.delete(documentType, dId);
      const diskResult = this.diskStore.delete(documentType, dId);
      return memResult || diskResult;
    }
    return this.activeStore().delete(documentType, dId);
  }

  has(documentType: string, dId: DocumentIdentifier): boolean {
    if (this.mode === 'auto') {
      return this.memoryStore.has(documentType, dId) || this.diskStore.has(documentType, dId);
    }
    return this.activeStore().has(documentType, dId);
  }

  listByDocumentType(documentType: string): DocumentIdentifier[] {
    if (this.mode === 'auto') {
      // Combine results from both stores, deduplicate by key
      const memDocs = this.memoryStore.listByDocumentType(documentType);
      const diskDocs = this.diskStore.listByDocumentType(documentType);
      const seen = new Set(memDocs.map((d) => dIdToString(d)));
      const combined = [...memDocs];
      for (const d of diskDocs) {
        if (!seen.has(dIdToString(d))) {
          combined.push(d);
        }
      }
      return combined;
    }
    return this.activeStore().listByDocumentType(documentType);
  }

  count(): number {
    if (this.mode === 'auto') {
      // Approximation: max of both (docs may exist in both stores)
      return Math.max(this.memoryStore.count(), this.diskStore.count());
    }
    return this.activeStore().count();
  }

  clear(): void {
    this.memoryStore.clear();
    this.diskStore.clear();
    if (this.hybridStore) {
      this.hybridStore.clear();
    }
  }

  // ─── T2.5: AUTO strategy — per-operation evaluation ─────────────────────

  /**
   * Resolve which backing store to use for a write operation.
   *
   * AUTO mode logic (from design.md):
   * - available memory > doc size × 10 → memory
   * - available memory < doc size × 2  → disk
   * - otherwise → hybrid (memory + disk)
   */
  private resolveTarget(document: InternalDocument): StorageAdapter {
    switch (this.mode) {
      case 'memory':
        return this.memoryStore;
      case 'disk':
        return this.diskStore;
      case 'hybrid':
        return this.hybridStore ?? this.memoryStore;
      case 'auto':
        return this.evaluateAutoStrategy(document);
    }
  }

  private evaluateAutoStrategy(document: InternalDocument): StorageAdapter {
    const availableMemory = freemem();
    const documentSize = estimateDocumentSize(document);

    if (availableMemory > documentSize * 10) {
      return this.memoryStore;
    } else if (availableMemory < documentSize * 2) {
      return this.diskStore;
    } else {
      // Middle ground: use both (write-through behaviour)
      // Store in memory for fast reads, disk for durability
      this.diskStore.store(document.documentType, document.dId, document);
      return this.memoryStore;
    }
  }

  /**
   * Get the primary backing store for the current mode.
   */
  private activeStore(): StorageAdapter {
    switch (this.mode) {
      case 'memory':
        return this.memoryStore;
      case 'disk':
        return this.diskStore;
      case 'hybrid':
        return this.hybridStore ?? this.memoryStore;
      case 'auto':
        // Fallback for reads — try memory first
        return this.memoryStore;
    }
  }

  /**
   * Migrate documents when switching strategy modes.
   */
  private migrateData(from: StorageStrategyMode, to: StorageStrategyMode): void {
    // Determine source store(s) and target store
    if (from === 'memory' && (to === 'disk' || to === 'hybrid')) {
      // Copy all memory documents to disk
      this.copyAllDocuments(this.memoryStore, this.diskStore);
    } else if (from === 'disk' && (to === 'memory' || to === 'hybrid')) {
      // Copy all disk documents to memory
      this.copyAllDocuments(this.diskStore, this.memoryStore);
    }
    // For hybrid→memory/disk and auto transitions, both stores already have data
  }

  private copyAllDocuments(source: StorageAdapter, target: StorageAdapter): void {
    // This is a best-effort migration. We can only enumerate what we know about.
    // In practice, the Document Manager will have a registry of document types.
    // For now, this relies on the MemoryStore's internal state.
    if (source instanceof MemoryStore) {
      // Access internal state for migration (package-internal operation)
      const docs = (source as unknown as { documents: Map<string, InternalDocument> }).documents;
      for (const doc of docs.values()) {
        target.store(doc.documentType, doc.dId, doc);
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Estimate the in-memory size of a document in bytes.
 * Uses a rough heuristic (JSON serialisation length × 2 for overhead).
 */
function estimateDocumentSize(document: InternalDocument): number {
  try {
    return JSON.stringify(document).length * 2;
  } catch {
    return 1024; // fallback estimate
  }
}

function dIdToString(dId: DocumentIdentifier): string {
  return dId.type === 'single' ? dId.value : dId.parts.join('\x00');
}
