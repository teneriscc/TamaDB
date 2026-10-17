/**
 * TTL Manager implementation (T10.1–T10.12)
 *
 * Manages TTL configuration, the auxiliary expiry table, background sweep,
 * on-access TTL checks, and salvageability classification (Best-Effort Read).
 *
 * Design reference: design.md § TTL Manager
 * Validates: Requirements 37, 37b
 */

import type { DocumentIdentifier, InternalDocument } from '../storage/types.js';
import { storageKey } from '../storage/types.js';
import type {
  Duration,
  ExpiryEntry,
  ExpiryReport,
  TtlCheckResult,
  TtlFloorWarning,
  TtlManager,
  TtlScope,
} from './types.js';

export class TtlManagerImpl implements TtlManager {
  /** Instance-level TTL (default: infinite). */
  private instanceTtl: Duration = 'infinite';

  /** Document_Type-level TTL: docType → duration. */
  private readonly docTypeTtls = new Map<string, Duration>();

  /** Document-level TTL: storageKey → duration. */
  private readonly documentTtls = new Map<string, Duration>();

  /** Auxiliary expiry table: storageKey → entry. Sorted by expiresAt for sweep efficiency. */
  private readonly expiryTable = new Map<string, ExpiryEntry>();

  /** Background sweep interval in ms (default: 1000ms). */
  private sweepIntervalMs = 1000;

  /** Estimated system processing time in seconds (for minimum floor calculation). */
  private readonly systemProcessingTime = 0.1; // 100ms conservative estimate

  // ─── T10.1: TTL Configuration ──────────────────────────────────────────

  configureTtl(scope: TtlScope, duration: Duration, target?: string): TtlFloorWarning | undefined {
    let warning: TtlFloorWarning | undefined;

    // T10.8: Apply TTL floor if needed
    if (typeof duration === 'number' && duration > 0) {
      const floor = this.getMinimumTtlFloor();
      if (duration < floor) {
        warning = {
          code: 'TTL_FLOOR_ADJUSTED',
          requestedTtl: duration,
          appliedTtl: floor,
          floor,
        };
        duration = floor;
      }
    }

    switch (scope) {
      case 'instance':
        this.instanceTtl = duration;
        break;
      case 'document_type':
        if (target) this.docTypeTtls.set(target, duration);
        break;
      case 'document':
        if (target) this.documentTtls.set(target, duration);
        break;
    }

    return warning;
  }

  // ─── T10.2: Effective TTL Resolution ───────────────────────────────────

  getEffectiveTtl(documentType: string, dId: DocumentIdentifier): Duration {
    // Most specific wins: document > Document_Type > instance
    const docKey = storageKey(documentType, dId);
    const docTtl = this.documentTtls.get(docKey);
    if (docTtl !== undefined) return docTtl;

    const typeTtl = this.docTypeTtls.get(documentType);
    if (typeTtl !== undefined) return typeTtl;

    return this.instanceTtl;
  }

  // ─── T10.3, T10.12: Expiry Table Management ───────────────────────────

  registerExpiry(
    documentType: string,
    dId: DocumentIdentifier,
    storeTimestamp: string,
    effectiveTtl: Duration,
    expireAt?: string,
  ): void {
    const key = storageKey(documentType, dId);

    if (effectiveTtl === 'infinite' && !expireAt) {
      // No expiry — remove from table if present
      this.expiryTable.delete(key);
      return;
    }

    let expiresAt: string;
    if (expireAt) {
      // Expire-at-Point-in-Time takes precedence for the expiry table
      expiresAt = expireAt;
    } else if (typeof effectiveTtl === 'number') {
      // Calculate absolute expiry: store timestamp + TTL seconds
      const storeDate = new Date(storeTimestamp);
      expiresAt = new Date(storeDate.getTime() + effectiveTtl * 1000).toISOString();
    } else {
      return; // infinite, no entry
    }

    this.expiryTable.set(key, {
      documentType,
      dId,
      expiresAt,
      hasExpireAtPolicy: expireAt !== undefined,
    });
  }

  removeExpiry(documentType: string, dId: DocumentIdentifier): void {
    const key = storageKey(documentType, dId);
    this.expiryTable.delete(key);
  }

  // ─── T10.4: Background Sweep ───────────────────────────────────────────

  sweep(now?: string): ExpiryReport {
    const currentTime = now ?? new Date().toISOString();
    let swept = 0;
    const errors = 0;
    const toRemove: string[] = [];

    for (const [key, entry] of this.expiryTable) {
      if (entry.expiresAt <= currentTime) {
        toRemove.push(key);
        swept++;
      }
    }

    // Remove swept entries from the table
    // (Actual soft-delete of documents is performed by the caller/integration layer)
    for (const key of toRemove) {
      this.expiryTable.delete(key);
    }

    return { swept, errors, timestamp: currentTime };
  }

  /**
   * Get all expired entries (for integration with Document Manager soft-delete).
   * Returns entries that have expired as of `now`.
   */
  getExpiredEntries(now?: string): ExpiryEntry[] {
    const currentTime = now ?? new Date().toISOString();
    const expired: ExpiryEntry[] = [];

    for (const entry of this.expiryTable.values()) {
      if (entry.expiresAt <= currentTime) {
        expired.push(entry);
      }
    }

    return expired;
  }

  // ─── T10.5, T10.10: On-Access TTL Check ────────────────────────────────

  checkOnAccess(doc: InternalDocument, now?: string): TtlCheckResult {
    const currentTime = now ?? new Date().toISOString();
    const key = storageKey(doc.documentType, doc.dId);
    const entry = this.expiryTable.get(key);

    // No expiry entry → document is valid
    if (!entry) {
      // Check if the document has a finite TTL but just isn't in the table yet.
      // The document's own TTL (TamaDB-TTL header) is the most specific rung
      // (Req 37.4) and wins over the configured type/instance TTL.
      const effectiveTtl = doc.ttl ?? this.getEffectiveTtl(doc.documentType, doc.dId);
      if (effectiveTtl === 'infinite') return { valid: true };

      // Req 37.3b / 37b.5a: expiry is a SLIDING WINDOW anchored to the
      // document's LAST UPDATE time (lastUpdateTime + effectiveTTL), re-armed on
      // every store. Here (the no-expiry-table-entry branch) we recompute from
      // the most recent store timestamp — the last timestampList entry — NOT
      // creationTime. A read reaching this path never advances the anchor; only
      // a store does (via registerExpiry on the onDocumentStored hook).
      const anchor =
        doc.timestampList[doc.timestampList.length - 1]?.requestTime ?? doc.creationTime;
      if (anchor) {
        const storeDate = new Date(anchor);
        const expiresAt = new Date(storeDate.getTime() + (effectiveTtl as number) * 1000);
        if (new Date(currentTime) < expiresAt) return { valid: true };
      } else {
        return { valid: true };
      }
    } else {
      // Entry exists — check if expired
      if (entry.expiresAt > currentTime) return { valid: true };
    }

    // Document is expired — classify (Best-Effort Read model, Req 32.8/32.8a).
    // T10.10: Salvageable if no Expire-at-Point-in-Time AND TTL > 0.
    // Document-level TTL (most specific, Req 37.4) wins over type/instance.
    const hasExpireAtPolicy = entry?.hasExpireAtPolicy ?? (doc.expireAt !== undefined);
    const effectiveTtl = doc.ttl ?? this.getEffectiveTtl(doc.documentType, doc.dId);

    if (!hasExpireAtPolicy && effectiveTtl !== 0) {
      // Salvageable → may be served as a Best-Effort Read (in place, no state
      // change, TTL unchanged). NOT a state transition back to live.
      return { valid: true, action: 'serve' };
    }

    // Not salvageable: Expire-at-Point-in-Time applies or TTL=0.
    const reason = hasExpireAtPolicy ? 'absolute-expired' as const : 'ttl-expired' as const;
    return { valid: false, action: 'soft-delete', reason };
  }

  // ─── T10.7: Minimum TTL Floor ──────────────────────────────────────────

  getMinimumTtlFloor(): number {
    // floor = max(system_processing_time, sweep_interval_in_seconds)
    const sweepIntervalSeconds = this.sweepIntervalMs / 1000;
    return Math.max(this.systemProcessingTime, sweepIntervalSeconds);
  }

  // ─── Sweep Interval ────────────────────────────────────────────────────

  getSweepInterval(): number {
    return this.sweepIntervalMs;
  }

  setSweepInterval(ms: number): void {
    this.sweepIntervalMs = ms > 0 ? ms : 1000;
  }

  getInstanceTtl(): Duration {
    return this.instanceTtl;
  }

  // ─── Persistence: Snapshot & Restore ────────────────────────────────────

  snapshot(): { instanceTtl: Duration; docTypeTtls: Array<{ documentType: string; ttl: Duration }>; documentTtls: Array<{ key: string; ttl: Duration }>; sweepIntervalMs: number } {
    const docTypeTtls: Array<{ documentType: string; ttl: Duration }> = [];
    for (const [dt, ttl] of this.docTypeTtls) {
      docTypeTtls.push({ documentType: dt, ttl });
    }
    const documentTtls: Array<{ key: string; ttl: Duration }> = [];
    for (const [key, ttl] of this.documentTtls) {
      documentTtls.push({ key, ttl });
    }
    return {
      instanceTtl: this.instanceTtl,
      docTypeTtls,
      documentTtls,
      sweepIntervalMs: this.sweepIntervalMs,
    };
  }

  restoreState(state: { instanceTtl: Duration; docTypeTtls: Array<{ documentType: string; ttl: Duration }>; documentTtls: Array<{ key: string; ttl: Duration }>; sweepIntervalMs: number }): void {
    this.instanceTtl = state.instanceTtl;
    this.sweepIntervalMs = state.sweepIntervalMs;
    this.docTypeTtls.clear();
    for (const entry of state.docTypeTtls) {
      this.docTypeTtls.set(entry.documentType, entry.ttl);
    }
    this.documentTtls.clear();
    for (const entry of state.documentTtls) {
      this.documentTtls.set(entry.key, entry.ttl);
    }
  }
}
