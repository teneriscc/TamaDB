/**
 * MEMORY Storage Strategy (T2.2)
 *
 * Implements the StorageAdapter interface using an in-memory Map.
 * All data resides in RAM — the operator is responsible for ensuring
 * sufficient memory. This is the fastest strategy and the primary
 * backing store for Increment 1.
 *
 * Design reference: design.md § Storage Adapter (MEMORY mode)
 * Validates: Requirement 22.1 (MEMORY), 22.3 (no per-op evaluation), 22.5 (speed priority)
 */

import type { DocumentIdentifier, InternalDocument, StorageAdapter } from './types.js';
import { storageKey } from './types.js';

export class MemoryStore implements StorageAdapter {
  private readonly documents = new Map<string, InternalDocument>();
  /** Secondary index: documentType → Set of storage keys for that type. */
  private readonly typeIndex = new Map<string, Set<string>>();

  store(documentType: string, dId: DocumentIdentifier, document: InternalDocument): void {
    const key = storageKey(documentType, dId);
    this.documents.set(key, document);

    // Maintain type index
    let typeSet = this.typeIndex.get(documentType);
    if (!typeSet) {
      typeSet = new Set();
      this.typeIndex.set(documentType, typeSet);
    }
    typeSet.add(key);
  }

  retrieve(documentType: string, dId: DocumentIdentifier): InternalDocument | undefined {
    const key = storageKey(documentType, dId);
    return this.documents.get(key);
  }

  delete(documentType: string, dId: DocumentIdentifier): boolean {
    const key = storageKey(documentType, dId);
    const existed = this.documents.delete(key);

    if (existed) {
      const typeSet = this.typeIndex.get(documentType);
      if (typeSet) {
        typeSet.delete(key);
        if (typeSet.size === 0) {
          this.typeIndex.delete(documentType);
        }
      }
    }

    return existed;
  }

  has(documentType: string, dId: DocumentIdentifier): boolean {
    const key = storageKey(documentType, dId);
    return this.documents.has(key);
  }

  listByDocumentType(documentType: string): DocumentIdentifier[] {
    const typeSet = this.typeIndex.get(documentType);
    if (!typeSet) return [];

    const results: DocumentIdentifier[] = [];
    for (const key of typeSet) {
      const doc = this.documents.get(key);
      if (doc) {
        results.push(doc.dId);
      }
    }
    return results;
  }

  count(): number {
    return this.documents.size;
  }

  clear(): void {
    this.documents.clear();
    this.typeIndex.clear();
  }
}
