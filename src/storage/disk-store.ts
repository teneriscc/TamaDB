/**
 * DISK Storage Strategy (T2.3)
 *
 * Implements the StorageAdapter interface using file-system-based persistence.
 * Each document is stored as a JSON file keyed by (documentType, dId).
 *
 * In Increment 1, this provides basic durability using the filesystem.
 * A future iteration may swap the underlying mechanism for an embedded
 * KV store (LMDB, better-sqlite3) without changing the interface.
 *
 * Design reference: design.md § Storage Adapter (DISK mode)
 * Validates: Requirement 22.1 (DISK)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentIdentifier, InternalDocument, StorageAdapter } from './types.js';
import { storageKey } from './types.js';

/**
 * Encode a storage key into a filesystem-safe filename.
 * Uses URL-safe base64 to handle arbitrary characters in keys.
 */
function keyToFilename(key: string): string {
  return Buffer.from(key, 'utf-8').toString('base64url') + '.json';
}

/**
 * Decode a filename back to a storage key.
 */
function filenameToKey(filename: string): string | undefined {
  if (!filename.endsWith('.json')) return undefined;
  const base = filename.slice(0, -5); // remove .json
  return Buffer.from(base, 'base64url').toString('utf-8');
}

export class DiskStore implements StorageAdapter {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  store(documentType: string, dId: DocumentIdentifier, document: InternalDocument): void {
    const key = storageKey(documentType, dId);
    const filepath = this.filepath(key);
    const serialized = JSON.stringify(document, mapReplacer);
    writeFileSync(filepath, serialized, 'utf-8');
  }

  retrieve(documentType: string, dId: DocumentIdentifier): InternalDocument | undefined {
    const key = storageKey(documentType, dId);
    const filepath = this.filepath(key);

    if (!existsSync(filepath)) return undefined;

    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw, mapReviver) as InternalDocument;
  }

  delete(documentType: string, dId: DocumentIdentifier): boolean {
    const key = storageKey(documentType, dId);
    const filepath = this.filepath(key);

    if (!existsSync(filepath)) return false;

    rmSync(filepath);
    return true;
  }

  has(documentType: string, dId: DocumentIdentifier): boolean {
    const key = storageKey(documentType, dId);
    const filepath = this.filepath(key);
    return existsSync(filepath);
  }

  listByDocumentType(documentType: string): DocumentIdentifier[] {
    const prefix = documentType + '\x01';
    const results: DocumentIdentifier[] = [];

    if (!existsSync(this.baseDir)) return results;

    for (const filename of readdirSync(this.baseDir)) {
      const key = filenameToKey(filename);
      if (key && key.startsWith(prefix)) {
        const filepath = join(this.baseDir, filename);
        const raw = readFileSync(filepath, 'utf-8');
        const doc = JSON.parse(raw, mapReviver) as InternalDocument;
        results.push(doc.dId);
      }
    }

    return results;
  }

  count(): number {
    if (!existsSync(this.baseDir)) return 0;
    return readdirSync(this.baseDir).filter((f) => f.endsWith('.json')).length;
  }

  clear(): void {
    if (!existsSync(this.baseDir)) return;
    for (const filename of readdirSync(this.baseDir)) {
      if (filename.endsWith('.json')) {
        rmSync(join(this.baseDir, filename));
      }
    }
  }

  private filepath(key: string): string {
    return join(this.baseDir, keyToFilename(key));
  }
}

// ─── JSON serialisation helpers for Map ─────────────────────────────────────

/**
 * JSON.stringify replacer that serialises Map instances as tagged arrays.
 */
function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return { __type: 'Map', entries: [...value.entries()] };
  }
  return value;
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
