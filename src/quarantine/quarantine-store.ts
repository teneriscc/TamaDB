/**
 * Quarantine Store implementation (T11.1–T11.9)
 *
 * Stores rejected payloads as-is for troubleshooting. FIFO eviction
 * when size limit reached. Never blocks the main store path.
 *
 * Design reference: design.md § Quarantine Store
 * Validates: Requirements 17.7–13, 21
 */

import type {
  QuarantineContext,
  QuarantineEntry,
  QuarantineListOptions,
  QuarantinePolicy,
  QuarantineStore,
  QuarantineUsage,
  RejectionType,
} from './types.js';

/** Data-error rejection types (quarantined under 'data-errors-only'). */
const DATA_ERROR_TYPES: ReadonlySet<RejectionType> = new Set([
  'parse-error',
  'validation-failure',
]);

export class QuarantineStoreImpl implements QuarantineStore {
  /** Quarantined entries in insertion order (oldest first). */
  private readonly entries: QuarantineEntry[] = [];

  /** Quick lookup by ref. */
  private readonly byRef = new Map<string, QuarantineEntry>();

  /** Current policy (T11.6: runtime-changeable, default: data-errors-only). */
  private policy: QuarantinePolicy = 'data-errors-only';

  /** Maximum number of entries before FIFO eviction (T11.3). */
  private maxSize = 1000;

  /** Counter for generating unique refs. */
  private refCounter = 0;

  /**
   * Optional persistence hook, injected at wiring time. Invoked whenever the
   * persisted quarantine state mutates (new entry, eviction, policy/size
   * change) so entries are durable at the moment they are created — decoupled
   * from the HTTP response status. Rejections return non-2xx, so the global
   * write-through hook (2xx-only) does not cover them; without this the audit
   * evidence could be lost on an ungraceful restart. Framework-agnostic: the
   * store does not import the persistence coordinator.
   */
  private persistHook: (() => void) | undefined;

  setPersistHook(hook: () => void): void {
    this.persistHook = hook;
  }

  // ─── T11.1, T11.2: Quarantine a Payload ────────────────────────────────

  quarantine(payload: unknown, context: QuarantineContext): string | undefined {
    // T11.4: Check policy
    if (!this.shouldQuarantine(context.rejectionType)) {
      return undefined;
    }

    // T11.3: FIFO eviction if at capacity (T11.9: never blocks)
    while (this.entries.length >= this.maxSize) {
      const evicted = this.entries.shift();
      if (evicted) {
        this.byRef.delete(evicted.ref);
      }
    }

    // T11.2: Generate unique reference
    const ref = this.generateRef();

    const entry: QuarantineEntry = { ref, payload, context };
    this.entries.push(entry);
    this.byRef.set(ref, entry);

    // Persist at creation time (audit durability, decoupled from HTTP status).
    this.persistHook?.();

    return ref;
  }

  // ─── T11.7: Retrieval & Listing ────────────────────────────────────────

  get(ref: string): QuarantineEntry | undefined {
    return this.byRef.get(ref);
  }

  list(options?: QuarantineListOptions): QuarantineEntry[] {
    let results = [...this.entries];

    // Filter by rejection type
    if (options?.rejectionType) {
      results = results.filter((e) => e.context.rejectionType === options.rejectionType);
    }

    // Filter by source identifier
    if (options?.sourceIdentifier) {
      results = results.filter((e) => e.context.sourceIdentifier === options.sourceIdentifier);
    }

    // Pagination
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  // ─── T11.4: Policy Enforcement ─────────────────────────────────────────

  shouldQuarantine(rejectionType: RejectionType): boolean {
    switch (this.policy) {
      case 'off':
        return false;
      case 'data-errors-only':
        return DATA_ERROR_TYPES.has(rejectionType);
      case 'all-rejections':
        return true;
    }
  }

  // ─── T11.6: Policy Configuration ──────────────────────────────────────

  getPolicy(): QuarantinePolicy {
    return this.policy;
  }

  setPolicy(policy: QuarantinePolicy): void {
    this.policy = policy;
    this.persistHook?.();
  }

  // ─── Usage & Size ──────────────────────────────────────────────────────

  getUsage(): QuarantineUsage {
    return { count: this.entries.length, maxSize: this.maxSize };
  }

  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize > 0 ? maxSize : 1;

    // Evict excess entries if reducing size
    while (this.entries.length > this.maxSize) {
      const evicted = this.entries.shift();
      if (evicted) {
        this.byRef.delete(evicted.ref);
      }
    }
    this.persistHook?.();
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private generateRef(): string {
    this.refCounter++;
    const timestamp = Date.now().toString(36);
    return `qr-${timestamp}-${this.refCounter.toString(36).padStart(4, '0')}`;
  }

  // ─── Persistence: Snapshot & Restore ────────────────────────────────────

  snapshot(): { entries: QuarantineEntry[]; policy: QuarantinePolicy; maxSize: number; refCounter: number } {
    return {
      entries: [...this.entries],
      policy: this.policy,
      maxSize: this.maxSize,
      refCounter: this.refCounter,
    };
  }

  restoreState(state: { entries: QuarantineEntry[]; policy: string; maxSize: number; refCounter: number }): void {
    this.entries.length = 0;
    this.byRef.clear();
    this.policy = state.policy as QuarantinePolicy;
    this.maxSize = state.maxSize;
    this.refCounter = state.refCounter;

    for (const entry of state.entries) {
      this.entries.push(entry);
      this.byRef.set(entry.ref, entry);
    }
  }
}
