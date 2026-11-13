/**
 * Unit tests for Component 11: Quarantine Store
 *
 * Covers T11.1 (storage), T11.2 (ref generation), T11.3 (FIFO eviction),
 * T11.4 (policy enforcement), T11.5 (context), T11.6 (policy config),
 * T11.7 (inspection API), T11.8 (not-found), T11.9 (never blocks).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { QuarantineStoreImpl } from '../src/quarantine/quarantine-store.js';
import type { QuarantineContext } from '../src/quarantine/types.js';

let store: QuarantineStoreImpl;

beforeEach(() => {
  store = new QuarantineStoreImpl();
});

function makeContext(overrides: Partial<QuarantineContext> = {}): QuarantineContext {
  return {
    receivedAt: '2026-01-01T00:00:00Z',
    sourceIdentifier: 'channel-1',
    rejectionReason: 'Test rejection',
    rejectionType: 'validation-failure',
    controlHeaders: {},
    ...overrides,
  };
}

// ─── T11.1: Payload Storage ─────────────────────────────────────────────────

describe('T11.1: Payload Storage', () => {
  it('stores payload as-is', () => {
    const payload = '{"invalid json - stored as-is';
    const ref = store.quarantine(payload, makeContext({ rejectionType: 'parse-error' }));
    expect(ref).toBeDefined();
    const entry = store.get(ref!);
    expect(entry?.payload).toBe(payload);
  });

  it('stores non-JSON payloads (binary-like)', () => {
    const payload = Buffer.from([0x00, 0x01, 0xff]);
    const ref = store.quarantine(payload, makeContext({ rejectionType: 'parse-error' }));
    expect(ref).toBeDefined();
    const entry = store.get(ref!);
    expect(entry?.payload).toBe(payload);
  });

  it('stores null payload', () => {
    const ref = store.quarantine(null, makeContext({ rejectionType: 'parse-error' }));
    expect(ref).toBeDefined();
    const entry = store.get(ref!);
    expect(entry?.payload).toBeNull();
  });
});

// ─── T11.2: Reference Generation ────────────────────────────────────────────

describe('T11.2: Reference Generation', () => {
  it('generates unique references', () => {
    const ref1 = store.quarantine('p1', makeContext({ rejectionType: 'parse-error' }));
    const ref2 = store.quarantine('p2', makeContext({ rejectionType: 'parse-error' }));
    expect(ref1).toBeDefined();
    expect(ref2).toBeDefined();
    expect(ref1).not.toBe(ref2);
  });

  it('refs start with "qr-" prefix', () => {
    const ref = store.quarantine('p1', makeContext({ rejectionType: 'parse-error' }));
    expect(ref).toBeDefined();
    expect(ref!.startsWith('qr-')).toBe(true);
  });
});

// ─── T11.3: FIFO Eviction ───────────────────────────────────────────────────

describe('T11.3: FIFO Eviction', () => {
  it('evicts oldest entry when max size reached', () => {
    store.setMaxSize(3);
    const ref1 = store.quarantine('first', makeContext({ rejectionType: 'parse-error' }));
    store.quarantine('second', makeContext({ rejectionType: 'parse-error' }));
    store.quarantine('third', makeContext({ rejectionType: 'parse-error' }));

    // Adding a fourth should evict the first
    store.quarantine('fourth', makeContext({ rejectionType: 'parse-error' }));

    expect(store.get(ref1!)).toBeUndefined(); // evicted
    expect(store.getUsage().count).toBe(3);
  });

  it('evicts multiple entries if needed when maxSize reduced', () => {
    store.quarantine('a', makeContext({ rejectionType: 'parse-error' }));
    store.quarantine('b', makeContext({ rejectionType: 'parse-error' }));
    store.quarantine('c', makeContext({ rejectionType: 'parse-error' }));
    store.quarantine('d', makeContext({ rejectionType: 'parse-error' }));

    store.setMaxSize(2);
    expect(store.getUsage().count).toBe(2);
  });
});

// ─── T11.4: Policy Enforcement ──────────────────────────────────────────────

describe('T11.4: Policy Enforcement', () => {
  it('data-errors-only (default): quarantines parse errors', () => {
    expect(store.shouldQuarantine('parse-error')).toBe(true);
  });

  it('data-errors-only: quarantines validation failures', () => {
    expect(store.shouldQuarantine('validation-failure')).toBe(true);
  });

  it('data-errors-only: does NOT quarantine enrichment conflicts', () => {
    expect(store.shouldQuarantine('enrichment-conflict')).toBe(false);
  });

  it('data-errors-only: does NOT quarantine channel-inactive', () => {
    expect(store.shouldQuarantine('channel-inactive')).toBe(false);
  });

  it('off: quarantines nothing', () => {
    store.setPolicy('off');
    expect(store.shouldQuarantine('parse-error')).toBe(false);
    expect(store.shouldQuarantine('validation-failure')).toBe(false);
  });

  it('all-rejections: quarantines everything', () => {
    store.setPolicy('all-rejections');
    expect(store.shouldQuarantine('parse-error')).toBe(true);
    expect(store.shouldQuarantine('enrichment-conflict')).toBe(true);
    expect(store.shouldQuarantine('channel-inactive')).toBe(true);
    expect(store.shouldQuarantine('schema-decommissioned')).toBe(true);
    expect(store.shouldQuarantine('document-type-not-found')).toBe(true);
  });

  it('returns undefined ref when policy says not to quarantine', () => {
    store.setPolicy('off');
    const ref = store.quarantine('payload', makeContext({ rejectionType: 'parse-error' }));
    expect(ref).toBeUndefined();
  });
});

// ─── T11.5: Context Storage ─────────────────────────────────────────────────

describe('T11.5: Context Storage', () => {
  it('stores full quarantine context', () => {
    const ctx = makeContext({
      receivedAt: '2026-06-15T10:30:00Z',
      sourceIdentifier: 'channel-sensor-1',
      schemaRef: 'temp-schema-v2',
      rejectionReason: 'Missing required field: deviceId',
      rejectionType: 'validation-failure',
    });

    const ref = store.quarantine('{"temperature": 25}', ctx);
    const entry = store.get(ref!);
    expect(entry?.context.receivedAt).toBe('2026-06-15T10:30:00Z');
    expect(entry?.context.sourceIdentifier).toBe('channel-sensor-1');
    expect(entry?.context.schemaRef).toBe('temp-schema-v2');
    expect(entry?.context.rejectionReason).toBe('Missing required field: deviceId');
    expect(entry?.context.rejectionType).toBe('validation-failure');
  });
});

// ─── T11.6: Policy Configuration ────────────────────────────────────────────

describe('T11.6: Policy Configuration', () => {
  it('default policy is data-errors-only', () => {
    expect(store.getPolicy()).toBe('data-errors-only');
  });

  it('policy is runtime-changeable', () => {
    store.setPolicy('all-rejections');
    expect(store.getPolicy()).toBe('all-rejections');

    store.setPolicy('off');
    expect(store.getPolicy()).toBe('off');
  });
});

// ─── T11.7: Read-Only Inspection API ────────────────────────────────────────

describe('T11.7: Inspection API', () => {
  it('lists all quarantined entries', () => {
    store.quarantine('p1', makeContext({ rejectionType: 'parse-error' }));
    store.quarantine('p2', makeContext({ rejectionType: 'validation-failure' }));
    expect(store.list()).toHaveLength(2);
  });

  it('filters by rejection type', () => {
    store.quarantine('p1', makeContext({ rejectionType: 'parse-error' }));
    store.quarantine('p2', makeContext({ rejectionType: 'validation-failure' }));

    const parseOnly = store.list({ rejectionType: 'parse-error' });
    expect(parseOnly).toHaveLength(1);
    expect(parseOnly[0]?.context.rejectionType).toBe('parse-error');
  });

  it('filters by source identifier', () => {
    store.quarantine('p1', makeContext({ sourceIdentifier: 'ch-1', rejectionType: 'parse-error' }));
    store.quarantine('p2', makeContext({ sourceIdentifier: 'ch-2', rejectionType: 'parse-error' }));

    const ch1Only = store.list({ sourceIdentifier: 'ch-1' });
    expect(ch1Only).toHaveLength(1);
  });

  it('supports pagination (limit + offset)', () => {
    for (let i = 0; i < 10; i++) {
      store.quarantine(`p${i}`, makeContext({ rejectionType: 'parse-error' }));
    }

    const page = store.list({ limit: 3, offset: 2 });
    expect(page).toHaveLength(3);
  });
});

// ─── T11.8: QUARANTINE_NOT_FOUND ────────────────────────────────────────────

describe('T11.8: Not Found', () => {
  it('returns undefined for non-existent ref', () => {
    expect(store.get('qr-nonexistent-0000')).toBeUndefined();
  });

  it('returns undefined for evicted ref', () => {
    store.setMaxSize(1);
    const ref1 = store.quarantine('first', makeContext({ rejectionType: 'parse-error' }));
    store.quarantine('second', makeContext({ rejectionType: 'parse-error' })); // evicts first
    expect(store.get(ref1!)).toBeUndefined();
  });
});

// ─── T11.9: Never Blocks ────────────────────────────────────────────────────

describe('T11.9: Never Blocks Store Path', () => {
  it('quarantine at capacity still accepts (evicts oldest)', () => {
    store.setMaxSize(2);
    store.quarantine('a', makeContext({ rejectionType: 'parse-error' }));
    store.quarantine('b', makeContext({ rejectionType: 'parse-error' }));

    // This should not throw or block
    const ref = store.quarantine('c', makeContext({ rejectionType: 'parse-error' }));
    expect(ref).toBeDefined();
    expect(store.getUsage().count).toBe(2);
  });
});
