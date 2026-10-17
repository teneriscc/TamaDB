/**
 * Channel Resolver types (T5.1–T5.10)
 *
 * Defines channel configuration, resolution results, status management,
 * and the ChannelResolver interface.
 *
 * Design reference: design.md § Channel Resolver
 * Validates: Requirements 47, 31
 */

import type { SchemaRef } from '../schema/types.js';

// ─── Channel Status ─────────────────────────────────────────────────────────

export type ChannelStatus = 'active' | 'inactive' | 'blocked';

// ─── Channel Configuration ──────────────────────────────────────────────────

export interface ChannelConfig {
  /** Globally unique channel identifier. */
  readonly channelId: string;
  /** Associated Document_Type name. */
  readonly documentType: string;
  /** Optional Channel_Schema reference. Falls back to Master_Schema if absent. */
  channelSchema?: SchemaRef;
  /** Per-channel enrichment bindings (managed by Enrichment Engine C17). */
  enrichmentBindings: EnrichmentBinding[];
  /** Current operational status. */
  status: ChannelStatus;
  /** Computed endpoint path. */
  readonly endpoint: string;
}

export interface EnrichmentBinding {
  readonly fieldPath: string;
  readonly staticValue: unknown;
}

// ─── Registration & Update ──────────────────────────────────────────────────

export interface RegisterChannelOptions {
  readonly channelId: string;
  readonly documentType: string;
  readonly channelSchema?: SchemaRef;
  /** Initial status. Default: 'active'. */
  readonly initialStatus?: 'active' | 'inactive';
}

export interface UpdateChannelOptions {
  readonly channelSchema?: SchemaRef | null; // null = remove
}

// ─── Channel Resolution ─────────────────────────────────────────────────────

export interface ChannelResolution {
  /** Resolved Document_Type name. */
  readonly documentType: string;
  /** Channel identifier (absent if documentType-level endpoint). */
  readonly channelId?: string;
  /** Applicable schema for validation (Channel_Schema or Master_Schema fallback). */
  readonly applicableSchema: SchemaRef;
  /** How the resolution was determined. */
  readonly source: 'url' | 'explicit';
  /** Populated when explicit differs from URL-derived. */
  readonly overrideWarning?: string;
}

export interface ExplicitContext {
  readonly documentType?: string;
  readonly schema?: SchemaRef;
}

// ─── URL Parse Result ───────────────────────────────────────────────────────

export interface UrlParseResult {
  readonly documentType: string;
  readonly channelId?: string;
}

// ─── Operation Results ──────────────────────────────────────────────────────

export interface ChannelSuccess {
  readonly success: true;
  readonly config: ChannelConfig;
}

export interface ChannelError {
  readonly success: false;
  readonly code: string;
  readonly message: string;
}

export type ChannelResult = ChannelSuccess | ChannelError;

export interface ChannelDeleteResult {
  readonly success: boolean;
  readonly code?: string;
  readonly message?: string;
}

export interface ChannelStatusResult {
  readonly success: boolean;
  readonly code?: string;
  readonly message?: string;
}

export interface ResolutionSuccess {
  readonly success: true;
  readonly resolution: ChannelResolution;
}

export interface ResolutionError {
  readonly success: false;
  readonly code: string;
  readonly message: string;
}

export type ResolutionResult = ResolutionSuccess | ResolutionError;

// ─── Channel Resolver Interface ─────────────────────────────────────────────

export interface ChannelResolver {
  /**
   * Parse a URL path to extract documentType and optional channelId (T5.1).
   */
  parseUrl(path: string): UrlParseResult | undefined;

  /**
   * Register a new channel (T5.2, T5.2b, T5.9).
   */
  register(options: RegisterChannelOptions): ChannelResult;

  /**
   * Update a channel's schema (T5.3).
   */
  update(channelId: string, updates: UpdateChannelOptions): ChannelResult;

  /**
   * Delete a channel (T5.4).
   */
  delete(channelId: string): ChannelDeleteResult;

  /**
   * Activate a channel (T5.6). Rejects activation of blocked channels.
   */
  activate(channelId: string): ChannelStatusResult;

  /**
   * Deactivate a channel (T5.6).
   */
  deactivate(channelId: string): ChannelStatusResult;

  /**
   * Block a channel (system-controlled, schema conflict).
   */
  block(channelId: string): ChannelStatusResult;

  /**
   * Resolve an ingestion request to the applicable Document_Type and schema (T5.7, T5.8, T5.10).
   */
  resolve(path: string, explicitOverride?: ExplicitContext): ResolutionResult;

  /**
   * Get a channel by ID.
   */
  get(channelId: string): ChannelConfig | undefined;

  /**
   * List channels, optionally filtered by Document_Type.
   */
  list(documentType?: string): ChannelConfig[];

  /**
   * Inject a read-through accessor to the Enrichment Engine (C17) so channel
   * views reflect the real per-channel bindings (source of truth stays the
   * engine; the channel config's enrichmentBindings is populated on read).
   */
  setEnrichmentBindingsProvider(provider: (channelId: string) => readonly EnrichmentBinding[]): void;
}
