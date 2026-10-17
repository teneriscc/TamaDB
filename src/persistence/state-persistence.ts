/**
 * State Persistence (Increment 1)
 *
 * Persists all runtime state to disk so TamaDB can resume exactly
 * where it left off after a restart. Each component's state is written
 * to a dedicated JSON file in the data directory.
 *
 * Files written:
 *   .tamadb-data/schemas.json
 *   .tamadb-data/document-types.json
 *   .tamadb-data/channels.json
 *   .tamadb-data/subscriptions.json
 *   .tamadb-data/quarantine.json
 *   .tamadb-data/enrichment.json
 *   .tamadb-data/ttl.json
 *   .tamadb-data/config.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DATA_DIR = '.tamadb-data';

// ─── Snapshot Types ──────────────────────────────────────────────────────────

export interface SchemasSnapshot {
  schemas: Array<{
    ref: string;
    schema: unknown;
    version: number;
    versions: Array<{ version: number; schema: unknown; createdAt: string }>;
    lifecycle: string;
    dIdDefinition?: { type: string; fields: readonly string[] };
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface DocumentTypesSnapshot {
  types: Array<{
    name: string;
    masterSchema: string;
    model: string;
    ttl?: number | 'infinite';
    channels: string[];
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface ChannelsSnapshot {
  channels: Array<{
    channelId: string;
    documentType: string;
    channelSchema?: string;
    status: string;
    endpoint: string;
  }>;
}

export interface SubscriptionsSnapshot {
  subscriptions: Array<{
    id: string;
    scope: string;
    documentType: string;
    dId?: unknown;
    path?: string;
    callbackUrl: string;
    options: Record<string, unknown>;
    active: boolean;
    createdAt: string;
  }>;
  idCounter: number;
}

export interface QuarantineSnapshot {
  entries: Array<{
    ref: string;
    payload: unknown;
    context: {
      receivedAt: string;
      sourceIdentifier: string;
      schemaRef?: string;
      rejectionReason: string;
      rejectionType: string;
      controlHeaders: Record<string, string>;
    };
  }>;
  policy: string;
  maxSize: number;
  refCounter: number;
}

export interface EnrichmentSnapshot {
  bindings: Array<{
    channelId: string;
    bindings: Array<{ fieldPath: string; staticValue: unknown }>;
  }>;
  policies: {
    precedence: string;
    conflictResolution: string;
  };
}

export interface TtlSnapshot {
  instanceTtl: number | 'infinite';
  docTypeTtls: Array<{ documentType: string; ttl: number | 'infinite' }>;
  documentTtls: Array<{ key: string; ttl: number | 'infinite' }>;
  sweepIntervalMs: number;
}

export interface ConfigSnapshot {
  logLevel: string;
  logDestination: string;
  logFilePath?: string;
  storageStrategy: string;
}

// ─── Persistence Manager ─────────────────────────────────────────────────────

export class StatePersistence {
  private readonly dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? DEFAULT_DATA_DIR;
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  // ─── Write Methods ──────────────────────────────────────────────────────

  saveSchemas(snapshot: SchemasSnapshot): void {
    this.writeFile('schemas.json', snapshot);
  }

  saveDocumentTypes(snapshot: DocumentTypesSnapshot): void {
    this.writeFile('document-types.json', snapshot);
  }

  saveChannels(snapshot: ChannelsSnapshot): void {
    this.writeFile('channels.json', snapshot);
  }

  saveSubscriptions(snapshot: SubscriptionsSnapshot): void {
    this.writeFile('subscriptions.json', snapshot);
  }

  saveQuarantine(snapshot: QuarantineSnapshot): void {
    this.writeFile('quarantine.json', snapshot);
  }

  saveEnrichment(snapshot: EnrichmentSnapshot): void {
    this.writeFile('enrichment.json', snapshot);
  }

  saveTtl(snapshot: TtlSnapshot): void {
    this.writeFile('ttl.json', snapshot);
  }

  saveConfig(snapshot: ConfigSnapshot): void {
    this.writeFile('config.json', snapshot);
  }

  // ─── Read Methods ───────────────────────────────────────────────────────

  loadSchemas(): SchemasSnapshot | undefined {
    return this.readFile<SchemasSnapshot>('schemas.json');
  }

  loadDocumentTypes(): DocumentTypesSnapshot | undefined {
    return this.readFile<DocumentTypesSnapshot>('document-types.json');
  }

  loadChannels(): ChannelsSnapshot | undefined {
    return this.readFile<ChannelsSnapshot>('channels.json');
  }

  loadSubscriptions(): SubscriptionsSnapshot | undefined {
    return this.readFile<SubscriptionsSnapshot>('subscriptions.json');
  }

  loadQuarantine(): QuarantineSnapshot | undefined {
    return this.readFile<QuarantineSnapshot>('quarantine.json');
  }

  loadEnrichment(): EnrichmentSnapshot | undefined {
    return this.readFile<EnrichmentSnapshot>('enrichment.json');
  }

  loadTtl(): TtlSnapshot | undefined {
    return this.readFile<TtlSnapshot>('ttl.json');
  }

  loadConfig(): ConfigSnapshot | undefined {
    return this.readFile<ConfigSnapshot>('config.json');
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private writeFile(filename: string, data: unknown): void {
    const filepath = join(this.dataDir, filename);
    writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private readFile<T>(filename: string): T | undefined {
    const filepath = join(this.dataDir, filename);
    if (!existsSync(filepath)) return undefined;
    try {
      const raw = readFileSync(filepath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
}
