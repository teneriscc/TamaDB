/**
 * Enrichment Engine types (T17.1–T17.23)
 *
 * Defines enrichment bindings, policies, conflict detection, and the
 * EnrichmentEngine interface.
 *
 * Design reference: design.md § Enrichment Engine
 * Validates: Requirements 48.1–48.24
 */

// ─── Enrichment Bindings ────────────────────────────────────────────────────

export interface EnrichmentBinding {
  readonly fieldPath: string;
  readonly staticValue: unknown;
}

// ─── Policies ───────────────────────────────────────────────────────────────

export type EnrichmentPrecedencePolicy = 'environment-over-content' | 'content-over-environment';
export type EnrichmentConflictResolutionPolicy = 'accept-and-warn' | 'discard-and-error';

export interface EnrichmentPolicies {
  precedence: EnrichmentPrecedencePolicy;
  conflictResolution: EnrichmentConflictResolutionPolicy;
}

// ─── Enrichment Result ──────────────────────────────────────────────────────

export interface EnrichmentResult {
  /** Parsed_Payload + populated bindings. */
  readonly enrichedDocument: Record<string, unknown>;
  /** Detected conflicts (may be empty). */
  readonly conflicts: readonly EnrichmentConflict[];
  /** 'rejected' only under discard-and-error policy with conflicts. */
  readonly outcome: 'success' | 'rejected';
  /** Foreign when enrichment supplies at least one identityKind-annotated field. */
  readonly dIdClassification: 'native' | 'foreign';
}

export interface EnrichmentConflict {
  readonly fieldPath: string;
  readonly enrichedValue: unknown;
  readonly payloadValue: unknown;
  readonly winner: 'environment' | 'content';
}

// ─── Binding Registration Result ────────────────────────────────────────────

export interface BindingRegistrationSuccess {
  readonly success: true;
  readonly dIdClassification: 'native' | 'foreign';
}

export interface BindingRegistrationError {
  readonly success: false;
  readonly code: string;
  readonly message: string;
}

export type BindingRegistrationResult = BindingRegistrationSuccess | BindingRegistrationError;

// ─── Consistency Check ──────────────────────────────────────────────────────

export interface EnrichmentConsistencySuccess {
  readonly consistent: true;
}

export interface EnrichmentConsistencyFailure {
  readonly consistent: false;
  readonly missingFields: readonly string[];
}

export type EnrichmentConsistencyResult = EnrichmentConsistencySuccess | EnrichmentConsistencyFailure;

// ─── Enrichment Engine Interface ────────────────────────────────────────────

export interface EnrichmentEngine {
  /**
   * Register/update bindings for a channel (T17.1, T17.2).
   */
  registerBindings(channelId: string, bindings: readonly EnrichmentBinding[]): BindingRegistrationResult;

  /**
   * Retrieve bindings for a channel (T17.6).
   */
  getBindings(channelId: string): readonly EnrichmentBinding[];

  /**
   * Remove all bindings for a channel (T17.7).
   */
  deleteBindings(channelId: string): boolean;

  /**
   * Execute the enrichment pipeline step (T17.9–T17.14).
   * Produces the Enriched_Document from Parsed_Payload + bindings.
   */
  enrich(parsedPayload: Record<string, unknown>, channelId: string): EnrichmentResult;

  /**
   * Check enrichment/Channel_Schema consistency (T17.4).
   * Every bound fieldPath must be in the Channel_Schema's properties.
   */
  checkConsistency(
    channelId: string,
    channelSchemaProperties: Record<string, unknown>,
  ): EnrichmentConsistencyResult;

  /**
   * Get the current enrichment policies (T17.15, T17.16).
   */
  getPolicies(): EnrichmentPolicies;

  /**
   * Set enrichment policies (T17.15).
   */
  setPolicies(policies: Partial<EnrichmentPolicies>): void;

  /**
   * Check if bindings target any identityKind-annotated field (T17.8).
   */
  classifyDId(
    channelId: string,
    identityFields: readonly string[],
  ): 'native' | 'foreign';
}
