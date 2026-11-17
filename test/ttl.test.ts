/**
 * Unit tests for Component 10: TTL Manager
 *
 * Covers T10.1 (configuration), T10.2 (hierarchy), T10.3 (expiry table),
 * T10.4 (sweep), T10.5 (on-access check), T10.6 (TTL=0), T10.7–T10.8 (floor),
 * T10.9 (Expire-at-Point-in-Time), T10.10 (Best-Effort Read salvageability), T10.12 (table updates).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TtlManagerImpl } from '../src/ttl/ttl-manager.js';
import type { InternalDocument, StoredBunch } from '../src/storage/types.js';

let ttl: TtlManagerImpl;

beforeEach(() => {
  ttl = new TtlManagerImpl();
});

function makeMinimalDoc(docType: string, dIdValue: string, overrides: Partial<InternalDocument> = {}): InternalDocument {
  const root: StoredBunch = {
    metadata: { timestampRef: { index: 0 }, versionNo: 1, history: [] },
    children: new Map(),
  };
  return {
    dId: { type: 'single', value: dIdValue },
    documentType: docType,
    creationTime: '2026-01-01T00:00:00Z',
    timestampList: [{ requestTime: '2026-01-01T00:00:00Z', commitTime: '2026-01-01T00:00:01Z', channelIdentifier: 'default' }],
    versionNo: 1,
    historyDepth: 5,
    model: 'closed',
    root,
    softDeleted: false,
    ...overrides,
  };
}

// ─── T10.1: TTL Configuration ───────────────────────────────────────────────

describe('T10.1: TTL Configuration', () => {
  it('configures instance-level TTL', () => {
    ttl.configureTtl('instance', 3600);
    expect(ttl.getInstanceTtl()).toBe(3600);
  });

  it('configures Document_Type-level TTL', () => {
    ttl.configureTtl('document_type', 1800, 'orders');
    expect(ttl.getEffectiveTtl('orders', { type: 'single', value: 'x' })).toBe(1800);
  });

  it('configures document-level TTL', () => {
    ttl.configureTtl('instance', 3600);
    // Document-level TTL requires the storage key format
    const dId = { type: 'single' as const, value: 'order-1' };
    const key = `orders\x01order-1`;
    ttl.configureTtl('document', 60, key);
    // Direct check via document TTL (note: target is the storageKey)
    expect(ttl.getEffectiveTtl('orders', dId)).toBe(60);
  });

  it('supports infinite TTL', () => {
    ttl.configureTtl('instance', 'infinite');
    expect(ttl.getInstanceTtl()).toBe('infinite');
  });
});

// ─── T10.2: TTL Hierarchy Resolution ────────────────────────────────────────

describe('T10.2: TTL Hierarchy', () => {
  it('document > Document_Type > instance', () => {
    ttl.configureTtl('instance', 3600);
    ttl.configureTtl('document_type', 1800, 'orders');

    const dId = { type: 'single' as const, value: 'order-1' };
    const key = `orders\x01order-1`;
    ttl.configureTtl('document', 60, key);

    expect(ttl.getEffectiveTtl('orders', dId)).toBe(60);
  });

  it('Document_Type > instance when no document TTL', () => {
    ttl.configureTtl('instance', 3600);
    ttl.configureTtl('document_type', 1800, 'orders');

    expect(ttl.getEffectiveTtl('orders', { type: 'single', value: 'any' })).toBe(1800);
  });

  it('falls back to instance when no more specific TTL', () => {
    ttl.configureTtl('instance', 3600);
    expect(ttl.getEffectiveTtl('orders', { type: 'single', value: 'any' })).toBe(3600);
  });

  it('returns infinite when nothing configured', () => {
    expect(ttl.getEffectiveTtl('orders', { type: 'single', value: 'any' })).toBe('infinite');
  });
});

// ─── T10.3 & T10.12: Expiry Table ──────────────────────────────────────────

describe('T10.3: Expiry Table', () => {
  it('registers document in expiry table', () => {
    const dId = { type: 'single' as const, value: 'order-1' };
    ttl.registerExpiry('orders', dId, '2026-01-01T00:00:00Z', 60);
    // Document should expire at 2026-01-01T00:01:00Z
    const expired = ttl.getExpiredEntries('2026-01-01T00:02:00Z');
    expect(expired).toHaveLength(1);
    expect(expired[0]?.dId).toEqual(dId);
  });

  it('does not register infinite TTL documents', () => {
    const dId = { type: 'single' as const, value: 'order-1' };
    ttl.registerExpiry('orders', dId, '2026-01-01T00:00:00Z', 'infinite');
    const expired = ttl.getExpiredEntries('2099-01-01T00:00:00Z');
    expect(expired).toHaveLength(0);
  });

  it('removes document from expiry table', () => {
    const dId = { type: 'single' as const, value: 'order-1' };
    ttl.registerExpiry('orders', dId, '2026-01-01T00:00:00Z', 60);
    ttl.removeExpiry('orders', dId);
    const expired = ttl.getExpiredEntries('2026-01-01T00:02:00Z');
    expect(expired).toHaveLength(0);
  });

  it('uses Expire-at-Point-in-Time when provided', () => {
    const dId = { type: 'single' as const, value: 'order-1' };
    ttl.registerExpiry('orders', dId, '2026-01-01T00:00:00Z', 3600, '2026-01-01T00:05:00Z');
    // Should expire at the absolute time, not TTL-based
    const expiredBefore = ttl.getExpiredEntries('2026-01-01T00:04:00Z');
    expect(expiredBefore).toHaveLength(0);
    const expiredAfter = ttl.getExpiredEntries('2026-01-01T00:06:00Z');
    expect(expiredAfter).toHaveLength(1);
  });
});

// ─── T10.4: Background Sweep ────────────────────────────────────────────────

describe('T10.4: Background Sweep', () => {
  it('sweeps expired documents', () => {
    const dId1 = { type: 'single' as const, value: 'order-1' };
    const dId2 = { type: 'single' as const, value: 'order-2' };
    ttl.registerExpiry('orders', dId1, '2026-01-01T00:00:00Z', 60);
    ttl.registerExpiry('orders', dId2, '2026-01-01T00:00:00Z', 120);

    // At T+90s: order-1 expired, order-2 still valid
    const report = ttl.sweep('2026-01-01T00:01:30Z');
    expect(report.swept).toBe(1);

    // order-2 should still be in the table
    const remaining = ttl.getExpiredEntries('2026-01-01T00:03:00Z');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.dId).toEqual(dId2);
  });

  it('returns 0 when nothing expired', () => {
    const dId = { type: 'single' as const, value: 'order-1' };
    ttl.registerExpiry('orders', dId, '2026-01-01T00:00:00Z', 3600);

    const report = ttl.sweep('2026-01-01T00:00:30Z');
    expect(report.swept).toBe(0);
  });
});

// ─── T10.5 & T10.10: On-Access TTL Check ────────────────────────────────────

describe('T10.5 & T10.10: On-Access Check', () => {
  it('valid when not expired', () => {
    ttl.configureTtl('instance', 3600);
    const doc = makeMinimalDoc('orders', 'order-1');

    const result = ttl.checkOnAccess(doc, '2026-01-01T00:30:00Z');
    expect(result.valid).toBe(true);
  });

  it('classifies as servable (Best-Effort Read) when expired with no Expire-at-Point-in-Time and TTL > 0', () => {
    ttl.configureTtl('instance', 60);
    const dId = { type: 'single' as const, value: 'order-1' };
    ttl.registerExpiry('orders', dId, '2026-01-01T00:00:00Z', 60);

    const doc = makeMinimalDoc('orders', 'order-1');
    const result = ttl.checkOnAccess(doc, '2026-01-01T00:02:00Z');
    expect(result.valid).toBe(true);
    // Best-Effort Read model: salvageable ⇒ action 'serve' (no reinstatement).
    expect(result.action).toBe('serve');
  });

  it('no-entry branch anchors on LAST UPDATE, not creationTime (0.4.0 sliding window, Req 37b.5a)', () => {
    // No expiry-table entry registered → checkOnAccess recomputes from the doc.
    // creationTime is far in the past; the last timestampList entry is recent.
    // Anchoring on the last update must report the doc LIVE even though it would
    // be long-expired if measured from creationTime.
    ttl.configureTtl('instance', 60); // 60s TTL
    const doc = makeMinimalDoc('orders', 'order-1', {
      creationTime: '2026-01-01T00:00:00Z',
      timestampList: [
        { requestTime: '2026-01-01T00:00:00Z', commitTime: '2026-01-01T00:00:01Z', channelIdentifier: 'default' },
        { requestTime: '2026-01-01T10:00:00Z', commitTime: '2026-01-01T10:00:01Z', channelIdentifier: 'default' },
      ],
    });

    // 30s after the LAST update (10:00:00) ⇒ live. (Measured from creationTime
    // 00:00:00 this instant is 10h past a 60s TTL ⇒ would be expired. 'valid'
    // with no action proves it anchors on the last update.)
    const live = ttl.checkOnAccess(doc, '2026-01-01T10:00:30Z');
    expect(live.valid).toBe(true);
    expect(live.action).toBeUndefined();

    // 90s after the last update ⇒ expired-but-salvageable ⇒ 'serve'.
    const expired = ttl.checkOnAccess(doc, '2026-01-01T10:01:30Z');
    expect(expired.valid).toBe(true);
    expect(expired.action).toBe('serve');
  });

  it('rejects when Expire-at-Point-in-Time applies', () => {
    const dId = { type: 'single' as const, value: 'order-1' };
    ttl.registerExpiry('orders', dId, '2026-01-01T00:00:00Z', 60, '2026-01-01T00:01:00Z');

    const doc = makeMinimalDoc('orders', 'order-1', { expireAt: '2026-01-01T00:01:00Z' });
    const result = ttl.checkOnAccess(doc, '2026-01-01T00:02:00Z');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('absolute-expired');
  });

  it('valid when infinite TTL', () => {
    ttl.configureTtl('instance', 'infinite');
    const doc = makeMinimalDoc('orders', 'order-1');
    const result = ttl.checkOnAccess(doc, '2099-12-31T00:00:00Z');
    expect(result.valid).toBe(true);
  });
});

// ─── T10.6: TTL=0 Behaviour ─────────────────────────────────────────────────

describe('T10.6: TTL=0', () => {
  it('TTL=0 document is not salvageable', () => {
    ttl.configureTtl('instance', 0);
    const dId = { type: 'single' as const, value: 'order-1' };
    ttl.registerExpiry('orders', dId, '2026-01-01T00:00:00Z', 0);

    const doc = makeMinimalDoc('orders', 'order-1');
    // TTL=0: immediately expired, not salvageable
    const result = ttl.checkOnAccess(doc, '2026-01-01T00:00:01Z');
    expect(result.valid).toBe(false);
    expect(result.action).toBe('soft-delete');
    expect(result.reason).toBe('ttl-expired');
  });
});

// ─── T10.7 & T10.8: Minimum TTL Floor ──────────────────────────────────────

describe('T10.7 & T10.8: TTL Floor', () => {
  it('calculates minimum TTL floor', () => {
    const floor = ttl.getMinimumTtlFloor();
    // Default sweep = 1000ms = 1s; system_processing_time = 0.1s
    // floor = max(0.1, 1) = 1
    expect(floor).toBe(1);
  });

  it('adjusts TTL to floor when below minimum', () => {
    const warning = ttl.configureTtl('instance', 0.5); // below floor of 1
    expect(warning).toBeDefined();
    expect(warning!.code).toBe('TTL_FLOOR_ADJUSTED');
    expect(warning!.appliedTtl).toBe(1);
    expect(ttl.getInstanceTtl()).toBe(1);
  });

  it('no warning when TTL is at or above floor', () => {
    const warning = ttl.configureTtl('instance', 5);
    expect(warning).toBeUndefined();
  });

  it('TTL=0 is not subject to floor (special value)', () => {
    // TTL=0 means "process and immediately soft-delete" — it's intentional
    const warning = ttl.configureTtl('instance', 0);
    expect(warning).toBeUndefined();
    expect(ttl.getInstanceTtl()).toBe(0);
  });

  it('floor adjusts when sweep interval changes', () => {
    ttl.setSweepInterval(5000); // 5s
    expect(ttl.getMinimumTtlFloor()).toBe(5);
  });
});

// ─── T10.9: Expire-at-Point-in-Time ────────────────────────────────────────

describe('T10.9: Expire-at-Point-in-Time', () => {
  it('marks entry as having expiry policy', () => {
    const dId = { type: 'single' as const, value: 'order-1' };
    ttl.registerExpiry('orders', dId, '2026-01-01T00:00:00Z', 3600, '2026-01-01T01:00:00Z');

    const expired = ttl.getExpiredEntries('2026-01-01T01:01:00Z');
    expect(expired).toHaveLength(1);
    expect(expired[0]?.hasExpireAtPolicy).toBe(true);
  });
});

// ─── Sweep Interval ─────────────────────────────────────────────────────────

describe('Sweep Interval', () => {
  it('defaults to 1000ms', () => {
    expect(ttl.getSweepInterval()).toBe(1000);
  });

  it('can be changed', () => {
    ttl.setSweepInterval(2000);
    expect(ttl.getSweepInterval()).toBe(2000);
  });

  it('rejects non-positive values (falls back to 1000)', () => {
    ttl.setSweepInterval(0);
    expect(ttl.getSweepInterval()).toBe(1000);
  });
});
