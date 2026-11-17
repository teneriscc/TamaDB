/**
 * Quarantine Store types (T11.1–T11.9)
 *
 * Defines quarantine policy, context, and the QuarantineStore interface.
 *
 * Design reference: design.md § Quarantine Store
 * Validates: Requirements 17.7–13, 21
 */

// ─── Quarantine Policy ──────────────────────────────────────────────────────

export type QuarantinePolicy = 'off' | 'data-errors-only' | 'all-rejections';

// ─── Rejection Types ────────────────────────────────────────────────────────

export type RejectionType =
  | 'parse-error'
  | 'validation-failure'
  | 'invalid-control-header'
  | 'enrichment-conflict'
  | 'schema-decommissioned'
  | 'schema-not-found'
  | 'channel-inactive'
  | 'channel-blocked'
  | 'channel-not-found'
  | 'document-type-not-found';

// ─── Quarantine Context ─────────────────────────────────────────────────────

export interface QuarantineContext {
  readonly receivedAt: string;
  readonly sourceIdentifier: string;
  readonly schemaRef?: string;
  readonly rejectionReason: string;
  readonly rejectionType: RejectionType;
  /**
   * The request's `TamaDB-*` Control_Headers, captured VERBATIM as received
   * (raw string values, before coercion), scoped strictly to the reserved
   * `TamaDB-*` namespace — never arbitrary headers such as `Authorization`.
   * An empty object means no Control_Headers were sent (audit fact: blind write).
   * Audit / non-repudiation evidence (Req 17.9–17.9a); recorded here in the
   * context, never merged into the quarantined payload (data plane stays pristine).
   */
  readonly controlHeaders: Readonly<Record<string, string>>;
}

// ─── Quarantine Entry ───────────────────────────────────────────────────────

export interface QuarantineEntry {
  /** Unique reference for this quarantined payload. */
  readonly ref: string;
  /** The raw payload as received (may be non-JSON). */
  readonly payload: unknown;
  /** Context about the rejection. */
  readonly context: QuarantineContext;
}

// ─── Quarantine Usage ───────────────────────────────────────────────────────

export interface QuarantineUsage {
  readonly count: number;
  readonly maxSize: number;
}

// ─── List/Filter Options ────────────────────────────────────────────────────

export interface QuarantineListOptions {
  readonly rejectionType?: RejectionType;
  readonly sourceIdentifier?: string;
  readonly limit?: number;
  readonly offset?: number;
}

// ─── Quarantine Store Interface ─────────────────────────────────────────────

export interface QuarantineStore {
  /**
   * Quarantine a rejected payload (T11.1, T11.2).
   * Returns the quarantine reference, or undefined if policy says not to quarantine.
   */
  quarantine(payload: unknown, context: QuarantineContext): string | undefined;

  /**
   * Retrieve a quarantined entry by ref (T11.7).
   */
  get(ref: string): QuarantineEntry | undefined;

  /**
   * List quarantined entries with optional filtering (T11.7).
   */
  list(options?: QuarantineListOptions): QuarantineEntry[];

  /**
   * Check if a rejection type should be quarantined per current policy (T11.4).
   */
  shouldQuarantine(rejectionType: RejectionType): boolean;

  /**
   * Get current quarantine policy (T11.6).
   */
  getPolicy(): QuarantinePolicy;

  /**
   * Set quarantine policy (T11.6). Runtime-changeable.
   */
  setPolicy(policy: QuarantinePolicy): void;

  /**
   * Get current usage stats.
   */
  getUsage(): QuarantineUsage;

  /**
   * Set maximum size limit (T11.3).
   */
  setMaxSize(maxSize: number): void;

  /**
   * Inject a persistence hook fired whenever persisted quarantine state
   * mutates, so rejection-path (non-2xx) entries are durable at creation time
   * rather than relying on a later 2xx mutation or graceful shutdown.
   */
  setPersistHook(hook: () => void): void;
}
