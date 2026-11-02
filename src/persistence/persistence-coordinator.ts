/**
 * Persistence Coordinator
 *
 * Orchestrates saving and restoring all component state using each
 * component's public API. Uses the StatePersistence layer for disk I/O.
 *
 * Design:
 * - Save: extracts state via public getters/list methods
 * - Restore: replays registration calls in dependency order
 * - Non-intrusive: doesn't modify component interfaces
 *
 * ─── ARCHITECTURAL NOTE (Technical Debt) ──────────────────────────────────
 *
 * This implementation uses type assertions (as unknown as {...}) to access
 * snapshot()/restoreState()/restoreEntry() methods that exist on the concrete
 * implementation classes but are NOT declared in the component interfaces.
 *
 * This was a pragmatic choice to avoid a large refactor of all component
 * interfaces during Increment 1. The trade-off:
 *   + Minimal change footprint — interfaces untouched, no downstream breakage
 *   - Type safety bypassed — compiler cannot verify these calls
 *   - Not portable — a rewrite in a stricter language (Rust, Java, Go) cannot
 *     replicate this pattern and MUST define persistence as part of the
 *     component contracts (traits, interfaces, protocols)
 *
 * Recommended refactoring for a rewrite or Increment 2:
 *   1. Define a Persistable<T> interface/trait with snapshot(): T and restore(T): void
 *   2. Have each component implement Persistable with its own snapshot type
 *   3. The coordinator takes Persistable references — no type assertions needed
 *   4. Alternatively, use a Memento pattern where each component owns its
 *      serialisation/deserialisation logic behind a clean contract
 *
 * See also: docs/working-notes/rust-rewrite-evaluation.md
 * ──────────────────────────────────────────────────────────────────────────
 */

import type { AppContext } from '../api/context.js';
import { getLoggingState, setLogLevel, setLogDestination } from '../logging/logger.js';
import type { LogLevel } from '../config.js';
import type { LogDestination } from '../logging/logger.js';
import { StatePersistence } from './state-persistence.js';
import type {
  SchemasSnapshot,
  DocumentTypesSnapshot,
  ChannelsSnapshot,
  SubscriptionsSnapshot,
  QuarantineSnapshot,
  EnrichmentSnapshot,
  TtlSnapshot,
  ConfigSnapshot,
} from './state-persistence.js';

export class PersistenceCoordinator {
  private readonly persistence: StatePersistence;
  private ctx: AppContext | undefined;

  constructor(dataDir?: string) {
    this.persistence = new StatePersistence(dataDir);
  }

  /** Set the application context (called after all components are wired). */
  setContext(ctx: AppContext): void {
    this.ctx = ctx;
  }

  // ─── Save All State ─────────────────────────────────────────────────────

  /** Persist all component state to disk. Called on shutdown and mutations. */
  saveAll(): void {
    if (!this.ctx) return;
    this.saveSchemas();
    this.saveDocumentTypes();
    this.saveChannels();
    this.saveSubscriptions();
    this.saveQuarantine();
    this.saveEnrichment();
    this.saveTtl();
    this.saveConfig();
  }

  saveSchemas(): void {
    if (!this.ctx) return;
    const entries = this.ctx.schemaManager.list();
    const snapshot: SchemasSnapshot = {
      schemas: entries.map((e) => ({
        ref: e.ref,
        schema: e.schema,
        version: e.version,
        versions: e.versions.map((v) => ({
          version: v.version,
          schema: v.schema,
          createdAt: v.timestamp,
        })),
        lifecycle: e.lifecycle,
        ...(e.dIdDefinition ? { dIdDefinition: { type: e.dIdDefinition.type, fields: [...e.dIdDefinition.fields] } } : {}),
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    };
    this.persistence.saveSchemas(snapshot);
  }

  saveDocumentTypes(): void {
    if (!this.ctx) return;
    const types = this.ctx.docTypeRegistry.list();
    const snapshot: DocumentTypesSnapshot = {
      types: types.map((t) => ({
        name: t.name,
        masterSchema: t.masterSchema,
        model: t.model,
        ...(t.ttl !== undefined ? { ttl: t.ttl } : {}),
        channels: t.channels ?? [],
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    };
    this.persistence.saveDocumentTypes(snapshot);
  }

  saveChannels(): void {
    if (!this.ctx) return;
    const channels = this.ctx.channelResolver.list();
    const snapshot: ChannelsSnapshot = {
      channels: channels.map((c) => ({
        channelId: c.channelId,
        documentType: c.documentType,
        ...(c.channelSchema ? { channelSchema: c.channelSchema } : {}),
        status: c.status,
        endpoint: c.endpoint,
      })),
    };
    this.persistence.saveChannels(snapshot);
  }

  saveSubscriptions(): void {
    if (!this.ctx) return;
    const mgr = this.ctx.subscriptionManager as unknown as { snapshot(): { subscriptions: unknown[]; idCounter: number } };
    const snapshot = mgr.snapshot() as SubscriptionsSnapshot;
    this.persistence.saveSubscriptions(snapshot);
  }

  saveQuarantine(): void {
    if (!this.ctx) return;
    const store = this.ctx.quarantineStore as unknown as { snapshot(): unknown };
    const snapshot = store.snapshot() as QuarantineSnapshot;
    this.persistence.saveQuarantine(snapshot);
  }

  saveEnrichment(): void {
    if (!this.ctx) return;
    const engine = this.ctx.enrichmentEngine as unknown as { snapshot(): unknown };
    const snapshot = engine.snapshot() as EnrichmentSnapshot;
    this.persistence.saveEnrichment(snapshot);
  }

  saveTtl(): void {
    if (!this.ctx) return;
    const mgr = this.ctx.ttlManager as unknown as { snapshot(): unknown };
    const snapshot = mgr.snapshot() as TtlSnapshot;
    this.persistence.saveTtl(snapshot);
  }

  saveConfig(): void {
    if (!this.ctx) return;
    const logState = getLoggingState();
    const snapshot: ConfigSnapshot = {
      logLevel: logState.level,
      logDestination: logState.destination,
      ...(logState.filePath ? { logFilePath: logState.filePath } : {}),
      storageStrategy: this.ctx.storageManager.getStrategy(),
    };
    this.persistence.saveConfig(snapshot);
  }

  // ─── Restore All State ──────────────────────────────────────────────────

  /**
   * Restore all state from disk. Must be called AFTER components are
   * instantiated but BEFORE the server starts listening.
   *
   * Restore order matters:
   * 1. Config (logging, storage strategy)
   * 2. Schemas (needed by Document_Types)
   * 3. Document_Types (needed by Channels)
   * 4. Channels
   * 5. Enrichment (bindings reference channels)
   * 6. Subscriptions
   * 7. TTL
   * 8. Quarantine
   */
  restoreAll(): { restored: boolean; components: string[] } {
    if (!this.ctx) return { restored: false, components: [] };

    const restored: string[] = [];

    if (this.restoreConfig()) restored.push('config');
    if (this.restoreSchemas()) restored.push('schemas');
    if (this.restoreDocumentTypes()) restored.push('document-types');
    if (this.restoreChannels()) restored.push('channels');
    if (this.restoreEnrichment()) restored.push('enrichment');
    if (this.restoreSubscriptions()) restored.push('subscriptions');
    if (this.restoreTtl()) restored.push('ttl');
    if (this.restoreQuarantine()) restored.push('quarantine');

    return { restored: restored.length > 0, components: restored };
  }

  private restoreConfig(): boolean {
    const snapshot = this.persistence.loadConfig();
    if (!snapshot) return false;

    setLogLevel(snapshot.logLevel as LogLevel);
    if (snapshot.logDestination) {
      setLogDestination(snapshot.logDestination as LogDestination, snapshot.logFilePath);
    }
    if (snapshot.storageStrategy && snapshot.storageStrategy !== this.ctx!.storageManager.getStrategy()) {
      this.ctx!.storageManager.setStrategy(snapshot.storageStrategy as 'auto' | 'memory' | 'disk' | 'hybrid');
    }
    return true;
  }

  private restoreSchemas(): boolean {
    const snapshot = this.persistence.loadSchemas();
    if (!snapshot || snapshot.schemas.length === 0) return false;

    const mgr = this.ctx!.schemaManager as unknown as { restoreEntry(entry: unknown): void };
    for (const s of snapshot.schemas) {
      mgr.restoreEntry({
        ref: s.ref,
        schema: s.schema as Record<string, unknown>,
        version: s.version,
        versions: s.versions.map((v) => ({ version: v.version, schema: v.schema as Record<string, unknown>, timestamp: v.createdAt })),
        lifecycle: s.lifecycle as 'active' | 'decommissioned',
        ...(s.dIdDefinition ? { dIdDefinition: s.dIdDefinition as { type: 'single' | 'composed'; fields: readonly string[] } } : {}),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      });
    }
    return true;
  }

  private restoreDocumentTypes(): boolean {
    const snapshot = this.persistence.loadDocumentTypes();
    if (!snapshot || snapshot.types.length === 0) return false;

    const reg = this.ctx!.docTypeRegistry as unknown as { restoreEntry(entry: unknown): void };
    for (const t of snapshot.types) {
      reg.restoreEntry({
        name: t.name,
        masterSchema: t.masterSchema,
        model: t.model as 'closed' | 'hybrid' | 'open',
        ttl: t.ttl,
        channels: t.channels,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      });
    }
    return true;
  }

  private restoreChannels(): boolean {
    const snapshot = this.persistence.loadChannels();
    if (!snapshot || snapshot.channels.length === 0) return false;

    const resolver = this.ctx!.channelResolver as unknown as { restoreEntry(entry: unknown): void };
    for (const c of snapshot.channels) {
      resolver.restoreEntry({
        channelId: c.channelId,
        documentType: c.documentType,
        channelSchema: c.channelSchema,
        status: c.status as 'active' | 'inactive' | 'blocked',
        endpoint: c.endpoint,
      });
    }
    return true;
  }

  private restoreEnrichment(): boolean {
    const snapshot = this.persistence.loadEnrichment();
    if (!snapshot) return false;

    const engine = this.ctx!.enrichmentEngine as unknown as { restoreState(state: unknown): void };
    engine.restoreState(snapshot);
    return true;
  }

  private restoreSubscriptions(): boolean {
    const snapshot = this.persistence.loadSubscriptions();
    if (!snapshot || snapshot.subscriptions.length === 0) return false;

    const mgr = this.ctx!.subscriptionManager as unknown as { restoreState(state: unknown): void };
    mgr.restoreState(snapshot);
    return true;
  }

  private restoreTtl(): boolean {
    const snapshot = this.persistence.loadTtl();
    if (!snapshot) return false;

    const mgr = this.ctx!.ttlManager as unknown as { restoreState(state: unknown): void };
    mgr.restoreState(snapshot);
    return true;
  }

  private restoreQuarantine(): boolean {
    const snapshot = this.persistence.loadQuarantine();
    if (!snapshot) return false;

    const store = this.ctx!.quarantineStore as unknown as { restoreState(state: unknown): void };
    store.restoreState(snapshot);
    return true;
  }
}
