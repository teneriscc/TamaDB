/**
 * HYBRID Storage Strategy (T2.4)
 *
 * Implements the StorageAdapter interface using a combined memory + disk approach.
 * Reads are memory-backed (fast). Data survives restarts (disk-backed).
 * No per-operation strategy evaluation overhead.
 *
 * Implementation: write-through — every write goes to both memory and disk.
 * On initialisation, the memory layer is populated from disk (warm-up).
 *
 * Design reference: design.md § Storage Adapter (HYBRID mode)
 * Validates: Requirement 22.1 (HYBRID), 22.3 (no per-op evaluation)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentIdentifier, InternalDocument, StorageAdapter } from './types.js';
import { DiskStore } from './disk-store.js';
import { MemoryStore } from './memory-store.js';

export class HybridStore implements StorageAdapter {
  private readonly memory: MemoryStore;
  private readonly disk: DiskStore;
  private readonly diskDir: string;

  constructor(diskDir: string) {
    this.diskDir = diskDir;
    this.memory = new MemoryStore();
    this.disk = new DiskStore(diskDir);
    this.warmUp();
  }

  store(documentType: string, dId: DocumentIdentifier, document: InternalDocument): void {
    // Write-through: both memory and disk
    this.memory.store(documentType, dId, document);
    this.disk.store(documentType, dId, document);
  }

  retrieve(documentType: string, dId: DocumentIdentifier): InternalDocument | undefined {
    // Reads from memory (fast path)
    return this.memory.retrieve(documentType, dId);
  }

  delete(documentType: string, dId: DocumentIdentifier): boolean {
    const memResult = this.memory.delete(documentType, dId);
    const diskResult = this.disk.delete(documentType, dId);
    return memResult || diskResult;
  }

  has(documentType: string, dId: DocumentIdentifier): boolean {
    return this.memory.has(documentType, dId);
  }

  listByDocumentType(documentType: string): DocumentIdentifier[] {
    return this.memory.listByDocumentType(documentType);
  }

  count(): number {
    return this.memory.count();
  }

  clear(): void {
    this.memory.clear();
    this.disk.clear();
  }

  /**
   * Populate the memory layer from disk on startup.
   * Reads all persisted documents into the in-memory store for fast access.
   */
  private warmUp(): void {
    if (!existsSync(this.diskDir)) return;

    const files = readdirSync(this.diskDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const filepath = join(this.diskDir, file);
        const raw = readFileSync(filepath, 'utf-8');
        const doc = JSON.parse(raw, mapReviver) as InternalDocument;
        // Load into memory only (disk already has it)
        this.memory.store(doc.documentType, doc.dId, doc);
      } catch {
        // Skip corrupt files during warm-up — log would go here in production
      }
    }
  }
}

/**
 * JSON.parse reviver that deserialises tagged arrays back into Maps.
 */
function mapReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    '__type' in value &&
    (value as Record<string, unknown>)['__type'] === 'Map' &&
    'entries' in value
  ) {
    return new Map((value as { entries: [string, unknown][] }).entries);
  }
  return value;
}
