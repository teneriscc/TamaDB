/**
 * Unit tests for Component 17: Enrichment Engine
 *
 * Covers T17.1–T17.16, T17.20–T17.23.
 * T17.17–T17.19 are integration wiring tasks (covered in C8).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EnrichmentEngineImpl } from '../src/enrichment/enrichment-engine.js';

let engine: EnrichmentEngineImpl;

beforeEach(() => {
  engine = new EnrichmentEngineImpl();
});

// ─── T17.1 & T17.2: Binding Registration ───────────────────────────────────

describe('T17.1 & T17.2: Binding Registration', () => {
  it('registers bindings for a channel', () => {
    const result = engine.registerBindings('ch-1', [
      { fieldPath: 'location', staticValue: 'Garage' },
      { fieldPath: 'deviceId', staticValue: 'XYZ123' },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects empty bindings', () => {
    const result = engine.registerBindings('ch-1', []);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('EMPTY_BINDINGS');
  });

  it('rejects binding with empty fieldPath', () => {
    const result = engine.registerBindings('ch-1', [{ fieldPath: '', staticValue: 'x' }]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('INVALID_FIELD_PATH');
  });

  it('overwrites previous bindings on re-registration', () => {
    engine.registerBindings('ch-1', [{ fieldPath: 'a', staticValue: 1 }]);
    engine.registerBindings('ch-1', [{ fieldPath: 'b', staticValue: 2 }]);
    const bindings = engine.getBindings('ch-1');
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.fieldPath).toBe('b');
  });
});

// ─── T17.6: Binding Retrieval ───────────────────────────────────────────────

describe('T17.6: Binding Retrieval', () => {
  it('retrieves registered bindings', () => {
    engine.registerBindings('ch-1', [{ fieldPath: 'location', staticValue: 'Garage' }]);
    const bindings = engine.getBindings('ch-1');
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toEqual({ fieldPath: 'location', staticValue: 'Garage' });
  });

  it('returns empty array for channel with no bindings', () => {
    expect(engine.getBindings('unknown')).toEqual([]);
  });
});

// ─── T17.7: Binding Deletion ────────────────────────────────────────────────

describe('T17.7: Binding Deletion', () => {
  it('deletes bindings for a channel', () => {
    engine.registerBindings('ch-1', [{ fieldPath: 'a', staticValue: 1 }]);
    expect(engine.deleteBindings('ch-1')).toBe(true);
    expect(engine.getBindings('ch-1')).toEqual([]);
  });

  it('returns false when no bindings to delete', () => {
    expect(engine.deleteBindings('unknown')).toBe(false);
  });
});

// ─── T17.9: Enrichment Pipeline Step ────────────────────────────────────────

describe('T17.9: Enrich Function', () => {
  it('populates binding values into the payload', () => {
    engine.registerBindings('ch-1', [
      { fieldPath: 'location', staticValue: 'Garage' },
      { fieldPath: 'deviceId', staticValue: 'XYZ123' },
    ]);

    const result = engine.enrich({ temperature: 25 }, 'ch-1');
    expect(result.outcome).toBe('success');
    expect(result.enrichedDocument).toEqual({
      temperature: 25,
      location: 'Garage',
      deviceId: 'XYZ123',
    });
  });
});

// ─── T17.10: No-Op Pass-Through ─────────────────────────────────────────────

describe('T17.10: No-Op Pass-Through', () => {
  it('returns payload unchanged when no bindings configured', () => {
    const payload = { temperature: 25, name: 'test' };
    const result = engine.enrich(payload, 'no-bindings-channel');
    expect(result.outcome).toBe('success');
    expect(result.enrichedDocument).toEqual(payload);
    expect(result.conflicts).toHaveLength(0);
  });
});

// ─── T17.11: Conflict Detection ─────────────────────────────────────────────

describe('T17.11: Conflict Detection', () => {
  it('detects conflict when payload and binding have different values', () => {
    engine.registerBindings('ch-1', [{ fieldPath: 'location', staticValue: 'Garage' }]);

    const result = engine.enrich({ location: 'Kitchen', temperature: 25 }, 'ch-1');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.fieldPath).toBe('location');
    expect(result.conflicts[0]?.enrichedValue).toBe('Garage');
    expect(result.conflicts[0]?.payloadValue).toBe('Kitchen');
  });
});

// ─── T17.12: Same-Value = No Conflict ───────────────────────────────────────

describe('T17.12: Same-Value Detection', () => {
  it('no conflict when payload and binding have same value', () => {
    engine.registerBindings('ch-1', [{ fieldPath: 'location', staticValue: 'Garage' }]);

    const result = engine.enrich({ location: 'Garage', temperature: 25 }, 'ch-1');
    expect(result.conflicts).toHaveLength(0);
    expect(result.outcome).toBe('success');
  });

  it('no conflict for deep-equal objects', () => {
    engine.registerBindings('ch-1', [{ fieldPath: 'meta', staticValue: { region: 'EU' } }]);

    const result = engine.enrich({ meta: { region: 'EU' } }, 'ch-1');
    expect(result.conflicts).toHaveLength(0);
  });

  it('no conflict for equal arrays', () => {
    engine.registerBindings('ch-1', [{ fieldPath: 'tags', staticValue: ['a', 'b'] }]);

    const result = engine.enrich({ tags: ['a', 'b'] }, 'ch-1');
    expect(result.conflicts).toHaveLength(0);
  });
});

// ─── T17.13: Enrichment Precedence Policy ───────────────────────────────────

describe('T17.13: Precedence Policy', () => {
  it('environment-over-content: enriched value wins (default)', () => {
    engine.registerBindings('ch-1', [{ fieldPath: 'location', staticValue: 'Garage' }]);

    const result = engine.enrich({ location: 'Kitchen' }, 'ch-1');
    expect(result.enrichedDocument['location']).toBe('Garage');
    expect(result.conflicts[0]?.winner).toBe('environment');
  });

  it('content-over-environment: payload value wins', () => {
    engine.setPolicies({ precedence: 'content-over-environment' });
    engine.registerBindings('ch-1', [{ fieldPath: 'location', staticValue: 'Garage' }]);

    const result = engine.enrich({ location: 'Kitchen' }, 'ch-1');
    expect(result.enrichedDocument['location']).toBe('Kitchen');
    expect(result.conflicts[0]?.winner).toBe('content');
  });
});

// ─── T17.14: Conflict Resolution Policy ────────────────────────────────────

describe('T17.14: Conflict Resolution Policy', () => {
  it('accept-and-warn: proceeds with conflicts (default)', () => {
    engine.registerBindings('ch-1', [{ fieldPath: 'location', staticValue: 'Garage' }]);

    const result = engine.enrich({ location: 'Kitchen' }, 'ch-1');
    expect(result.outcome).toBe('success');
    expect(result.conflicts).toHaveLength(1);
  });

  it('discard-and-error: rejects on conflict', () => {
    engine.setPolicies({ conflictResolution: 'discard-and-error' });
    engine.registerBindings('ch-1', [{ fieldPath: 'location', staticValue: 'Garage' }]);

    const result = engine.enrich({ location: 'Kitchen' }, 'ch-1');
    expect(result.outcome).toBe('rejected');
    expect(result.conflicts).toHaveLength(1);
  });

  it('discard-and-error: returns original payload (not enriched)', () => {
    engine.setPolicies({ conflictResolution: 'discard-and-error' });
    engine.registerBindings('ch-1', [
      { fieldPath: 'location', staticValue: 'Garage' },
      { fieldPath: 'extra', staticValue: 'added' },
    ]);

    const payload = { location: 'Kitchen', temperature: 25 };
    const result = engine.enrich(payload, 'ch-1');
    expect(result.outcome).toBe('rejected');
    // Original payload returned, not enriched
    expect(result.enrichedDocument).toEqual(payload);
  });

  it('discard-and-error: no rejection when no conflicts', () => {
    engine.setPolicies({ conflictResolution: 'discard-and-error' });
    engine.registerBindings('ch-1', [{ fieldPath: 'location', staticValue: 'Garage' }]);

    const result = engine.enrich({ temperature: 25 }, 'ch-1');
    expect(result.outcome).toBe('success');
  });
});

// ─── T17.15 & T17.16: Policy Management ────────────────────────────────────

describe('T17.15 & T17.16: Policy Management', () => {
  it('has correct default policies', () => {
    const policies = engine.getPolicies();
    expect(policies.precedence).toBe('environment-over-content');
    expect(policies.conflictResolution).toBe('accept-and-warn');
  });

  it('updates policies independently', () => {
    engine.setPolicies({ precedence: 'content-over-environment' });
    const policies = engine.getPolicies();
    expect(policies.precedence).toBe('content-over-environment');
    expect(policies.conflictResolution).toBe('accept-and-warn'); // unchanged
  });

  it('updates both policies', () => {
    engine.setPolicies({
      precedence: 'content-over-environment',
      conflictResolution: 'discard-and-error',
    });
    const policies = engine.getPolicies();
    expect(policies.precedence).toBe('content-over-environment');
    expect(policies.conflictResolution).toBe('discard-and-error');
  });
});

// ─── T17.4: Channel_Schema Consistency Check ────────────────────────────────

describe('T17.4: Channel_Schema Consistency', () => {
  it('consistent when all bound fields are in Channel_Schema', () => {
    engine.registerBindings('ch-1', [
      { fieldPath: 'location', staticValue: 'Garage' },
      { fieldPath: 'deviceId', staticValue: 'XYZ' },
    ]);

    const result = engine.checkConsistency('ch-1', {
      location: { type: 'string' },
      deviceId: { type: 'string' },
      temperature: { type: 'number' },
    });
    expect(result.consistent).toBe(true);
  });

  it('inconsistent when bound field missing from Channel_Schema', () => {
    engine.registerBindings('ch-1', [
      { fieldPath: 'location', staticValue: 'Garage' },
      { fieldPath: 'secretField', staticValue: 'hidden' },
    ]);

    const result = engine.checkConsistency('ch-1', {
      location: { type: 'string' },
      temperature: { type: 'number' },
    });
    expect(result.consistent).toBe(false);
    if (result.consistent) return;
    expect(result.missingFields).toContain('secretField');
  });

  it('consistent when no bindings configured', () => {
    const result = engine.checkConsistency('no-bindings', {
      name: { type: 'string' },
    });
    expect(result.consistent).toBe(true);
  });
});

// ─── T17.8: Foreign D-Id Classification ─────────────────────────────────────

describe('T17.8: Foreign D-Id Classification', () => {
  it('native when no bindings target identity fields', () => {
    engine.registerBindings('ch-1', [{ fieldPath: 'location', staticValue: 'Garage' }]);
    expect(engine.classifyDId('ch-1', ['orderId', 'customerId'])).toBe('native');
  });

  it('foreign when any binding targets an identity field', () => {
    engine.registerBindings('ch-1', [
      { fieldPath: 'location', staticValue: 'Garage' },
      { fieldPath: 'deviceId', staticValue: 'XYZ' },
    ]);
    expect(engine.classifyDId('ch-1', ['deviceId'])).toBe('foreign');
  });

  it('native when no bindings exist', () => {
    expect(engine.classifyDId('no-bindings', ['id'])).toBe('native');
  });
});

// ─── T17.22: Non-Retroactive Behaviour ──────────────────────────────────────

describe('T17.22: Non-Retroactive Behaviour', () => {
  it('changing bindings does not affect previous enrichment results', () => {
    engine.registerBindings('ch-1', [{ fieldPath: 'location', staticValue: 'Garage' }]);
    const result1 = engine.enrich({ temperature: 25 }, 'ch-1');
    expect(result1.enrichedDocument['location']).toBe('Garage');

    // Change bindings
    engine.registerBindings('ch-1', [{ fieldPath: 'location', staticValue: 'Attic' }]);
    // Previous result is unchanged (immutable)
    expect(result1.enrichedDocument['location']).toBe('Garage');

    // New enrichment uses new bindings
    const result2 = engine.enrich({ temperature: 30 }, 'ch-1');
    expect(result2.enrichedDocument['location']).toBe('Attic');
  });
});

// ─── T17.23: Unconditional Enrichment Under Override ────────────────────────

describe('T17.23: Unconditional Enrichment', () => {
  it('enrichment always applies regardless of Document_Type context', () => {
    // Enrichment is channel-bound, not Document_Type-bound.
    // Even if the Document Manager uses an explicit override for Document_Type,
    // the enrichment step runs based on the channel's bindings.
    engine.registerBindings('ch-1', [{ fieldPath: 'source', staticValue: 'channel-1' }]);

    // Simulating: payload arrives on ch-1, producer overrides to a different docType
    // The enrich() function only cares about channelId, not docType
    const result = engine.enrich({ data: 'hello' }, 'ch-1');
    expect(result.outcome).toBe('success');
    expect(result.enrichedDocument['source']).toBe('channel-1');
  });
});
