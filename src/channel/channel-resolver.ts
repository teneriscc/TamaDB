/**
 * Channel Resolver implementation (T5.1–T5.10)
 *
 * Manages channel registration, status, and resolves ingestion requests
 * to the applicable Document_Type and schema.
 *
 * Design reference: design.md § Channel Resolver
 * Validates: Requirements 47, 31
 */

import type { DocumentTypeRegistry } from '../document-type/types.js';
import type {
  ChannelConfig,
  ChannelDeleteResult,
  ChannelResolver,
  ChannelResult,
  ChannelStatusResult,
  EnrichmentBinding,
  ExplicitContext,
  RegisterChannelOptions,
  ResolutionResult,
  UpdateChannelOptions,
  UrlParseResult,
} from './types.js';

const API_PREFIX = '/api/v1/ingest/';

export class ChannelResolverImpl implements ChannelResolver {
  /** Channel registry: channelId → config. */
  private readonly channels = new Map<string, ChannelConfig>();

  /** Reference to Document_Type Registry for lookups. */
  private readonly docTypeRegistry: DocumentTypeRegistry;

  /**
   * Read-through accessor to the Enrichment Engine (C17), the source of truth
   * for enrichment bindings. Injected at wiring time (mirrors the
   * setMasterSchemaChecker pattern) so the channel view reflects real bindings
   * without a second divergent store. Defect: enrichmentBindings was hardcoded
   * to []; the engine held the real data.
   */
  private enrichmentBindingsProvider: ((channelId: string) => readonly EnrichmentBinding[]) | undefined;

  constructor(docTypeRegistry: DocumentTypeRegistry) {
    this.docTypeRegistry = docTypeRegistry;
  }

  setEnrichmentBindingsProvider(provider: (channelId: string) => readonly EnrichmentBinding[]): void {
    this.enrichmentBindingsProvider = provider;
  }

  /** Overlay the live enrichment bindings (read-through) onto a channel config. */
  private withBindings(config: ChannelConfig): ChannelConfig {
    if (!this.enrichmentBindingsProvider) return config;
    return { ...config, enrichmentBindings: [...this.enrichmentBindingsProvider(config.channelId)] };
  }

  // ─── T5.1: URL Path Parsing ─────────────────────────────────────────────

  parseUrl(path: string): UrlParseResult | undefined {
    // Expected formats:
    //   /api/v1/ingest/{documentType}
    //   /api/v1/ingest/{documentType}/{channelId}
    const normalized = path.startsWith('/') ? path : '/' + path;

    if (!normalized.startsWith(API_PREFIX)) return undefined;

    const remainder = normalized.slice(API_PREFIX.length);
    if (!remainder || remainder.length === 0) return undefined;

    const parts = remainder.split('/').filter((p) => p.length > 0);
    if (parts.length === 0 || parts.length > 2) return undefined;

    const documentType = parts[0]!;
    const channelId = parts.length === 2 ? parts[1] : undefined;

    return channelId !== undefined ? { documentType, channelId } : { documentType };
  }

  // ─── T5.2, T5.2b, T5.9: Channel Registration ──────────────────────────

  register(options: RegisterChannelOptions): ChannelResult {
    const { channelId, documentType, channelSchema, initialStatus } = options;

    // T5.2b: Global uniqueness enforcement
    if (this.channels.has(channelId)) {
      return {
        success: false,
        code: 'CHANNEL_ALREADY_EXISTS',
        message: `Channel '${channelId}' already exists`,
      };
    }

    // Verify Document_Type exists
    const docType = this.docTypeRegistry.get(documentType);
    if (!docType) {
      return {
        success: false,
        code: 'DOCUMENT_TYPE_NOT_FOUND',
        message: `Document_Type '${documentType}' not found`,
      };
    }

    // T5.9: Default status is 'active' unless specified as 'inactive'
    const status = initialStatus ?? 'active';
    const endpoint = `/api/v1/ingest/${documentType}/${channelId}`;

    const config: ChannelConfig = {
      channelId,
      documentType,
      ...(channelSchema !== undefined ? { channelSchema } : {}),
      enrichmentBindings: [],
      status,
      endpoint,
    };

    this.channels.set(channelId, config);

    // T4.7: Notify Document_Type Registry of new channel
    this.docTypeRegistry.addChannel(documentType, channelId);

    return { success: true, config };
  }

  // ─── T5.3: Channel Update ──────────────────────────────────────────────

  update(channelId: string, updates: UpdateChannelOptions): ChannelResult {
    const config = this.channels.get(channelId);
    if (!config) {
      return { success: false, code: 'CHANNEL_NOT_FOUND', message: `Channel '${channelId}' not found` };
    }

    if (updates.channelSchema === null) {
      delete config.channelSchema;
    } else if (updates.channelSchema !== undefined) {
      config.channelSchema = updates.channelSchema;
    }

    return { success: true, config };
  }

  // ─── T5.4: Channel Deletion ────────────────────────────────────────────

  delete(channelId: string): ChannelDeleteResult {
    const config = this.channels.get(channelId);
    if (!config) {
      return { success: false, code: 'CHANNEL_NOT_FOUND', message: `Channel '${channelId}' not found` };
    }

    this.channels.delete(channelId);

    // Notify Document_Type Registry
    this.docTypeRegistry.removeChannel(config.documentType, channelId);

    return { success: true };
  }

  // ─── T5.5 & T5.6: Status Management ───────────────────────────────────

  activate(channelId: string): ChannelStatusResult {
    const config = this.channels.get(channelId);
    if (!config) {
      return { success: false, code: 'CHANNEL_NOT_FOUND', message: `Channel '${channelId}' not found` };
    }

    // Cannot activate a blocked channel (Req 47.14)
    if (config.status === 'blocked') {
      return {
        success: false,
        code: 'CHANNEL_BLOCKED',
        message: `Cannot activate channel '${channelId}': schema conflict must be resolved first`,
      };
    }

    if (config.status === 'active') {
      return { success: true }; // Already active, no-op
    }

    config.status = 'active';
    return { success: true };
  }

  deactivate(channelId: string): ChannelStatusResult {
    const config = this.channels.get(channelId);
    if (!config) {
      return { success: false, code: 'CHANNEL_NOT_FOUND', message: `Channel '${channelId}' not found` };
    }

    if (config.status === 'inactive') {
      return { success: true }; // Already inactive, no-op
    }

    // blocked → inactive is NOT permitted (resolve conflict first)
    if (config.status === 'blocked') {
      return {
        success: false,
        code: 'CHANNEL_BLOCKED',
        message: `Cannot deactivate channel '${channelId}': resolve schema conflict first`,
      };
    }

    config.status = 'inactive';
    return { success: true };
  }

  block(channelId: string): ChannelStatusResult {
    const config = this.channels.get(channelId);
    if (!config) {
      return { success: false, code: 'CHANNEL_NOT_FOUND', message: `Channel '${channelId}' not found` };
    }

    config.status = 'blocked';
    return { success: true };
  }

  // ─── T5.7, T5.8, T5.10: Resolution Logic ──────────────────────────────

  resolve(path: string, explicitOverride?: ExplicitContext): ResolutionResult {
    const parsed = this.parseUrl(path);
    if (!parsed) {
      return { success: false, code: 'INVALID_PATH', message: 'Could not parse ingestion path' };
    }

    // T5.8: Explicit override takes precedence
    const effectiveDocType = explicitOverride?.documentType ?? parsed.documentType;

    // Verify Document_Type exists
    const docType = this.docTypeRegistry.get(effectiveDocType);
    if (!docType) {
      return {
        success: false,
        code: 'DOCUMENT_TYPE_NOT_FOUND',
        message: `Document_Type '${effectiveDocType}' not found`,
      };
    }

    // Build override warning if explicit differs from URL
    let overrideWarning: string | undefined;
    if (explicitOverride?.documentType && explicitOverride.documentType !== parsed.documentType) {
      overrideWarning = `Explicit Document_Type '${explicitOverride.documentType}' differs from URL-derived '${parsed.documentType}'`;
    }

    // If explicit schema override provided, use it directly
    if (explicitOverride?.schema) {
      if (!overrideWarning && parsed.channelId) {
        overrideWarning = `Explicit schema '${explicitOverride.schema}' overrides channel-derived schema`;
      }
      const resolution: import('./types.js').ChannelResolution = {
        documentType: effectiveDocType,
        ...(parsed.channelId !== undefined ? { channelId: parsed.channelId } : {}),
        applicableSchema: explicitOverride.schema,
        source: 'explicit',
        ...(overrideWarning !== undefined ? { overrideWarning } : {}),
      };
      return { success: true, resolution };
    }

    // Channel-level resolution
    if (parsed.channelId) {
      const channel = this.channels.get(parsed.channelId);
      if (!channel) {
        return {
          success: false,
          code: 'CHANNEL_NOT_FOUND',
          message: `Channel '${parsed.channelId}' not found`,
        };
      }

      // Verify channel belongs to the resolved Document_Type
      if (channel.documentType !== effectiveDocType) {
        return {
          success: false,
          code: 'CHANNEL_NOT_FOUND',
          message: `Channel '${parsed.channelId}' does not belong to Document_Type '${effectiveDocType}'`,
        };
      }

      // Status check
      if (channel.status === 'inactive') {
        return {
          success: false,
          code: 'CHANNEL_INACTIVE',
          message: `Channel '${parsed.channelId}' is deactivated`,
        };
      }
      if (channel.status === 'blocked') {
        return {
          success: false,
          code: 'CHANNEL_BLOCKED',
          message: `Channel '${parsed.channelId}' is blocked due to schema consistency issue`,
        };
      }

      // Resolve schema: Channel_Schema or Master_Schema fallback
      const applicableSchema = channel.channelSchema ?? docType.masterSchema;

      return {
        success: true,
        resolution: {
          documentType: effectiveDocType,
          channelId: parsed.channelId,
          applicableSchema,
          source: overrideWarning ? 'explicit' : 'url',
          ...(overrideWarning !== undefined ? { overrideWarning } : {}),
        },
      };
    }

    // Document_Type-level resolution (no channel): Master_Schema
    return {
      success: true,
      resolution: {
        documentType: effectiveDocType,
        applicableSchema: docType.masterSchema,
        source: overrideWarning ? 'explicit' : 'url',
        ...(overrideWarning !== undefined ? { overrideWarning } : {}),
      },
    };
  }

  // ─── Accessors ──────────────────────────────────────────────────────────

  get(channelId: string): ChannelConfig | undefined {
    const config = this.channels.get(channelId);
    return config ? this.withBindings(config) : undefined;
  }

  list(documentType?: string): ChannelConfig[] {
    const all = [...this.channels.values()];
    const filtered = documentType ? all.filter((c) => c.documentType === documentType) : all;
    return filtered.map((c) => this.withBindings(c));
  }

  // ─── Persistence: Restore ───────────────────────────────────────────────

  /**
   * Restore a channel entry from a persisted snapshot.
   */
  restoreEntry(entry: { channelId: string; documentType: string; channelSchema?: string; status: 'active' | 'inactive' | 'blocked'; endpoint: string }): void {
    const config: ChannelConfig = {
      channelId: entry.channelId,
      documentType: entry.documentType,
      ...(entry.channelSchema ? { channelSchema: entry.channelSchema } : {}),
      enrichmentBindings: [],
      status: entry.status,
      endpoint: entry.endpoint,
    };
    this.channels.set(entry.channelId, config);
  }
}
