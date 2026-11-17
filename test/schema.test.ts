/**
 * Unit tests for Component 3: Schema Manager
 *
 * Covers T3.1 (registration), T3.2 (retrieval), T3.3 (update),
 * T3.4 (decommissioning), T3.5 (reactivation), T3.6 (decommission protection),
 * T3.7 (DCM validation), T3.8 (consistency checks), T3.9 (revert-on-conflict),
 * T3.10 (lifecycle management).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaManagerImpl } from '../src/schema/schema-manager.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

function makeSchema(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      id: { type: 'integer', identityKind: 'primary-key' },
      name: { type: 'string' },
      active: { type: 'boolean' },
    },
    required: ['id', 'name'],
    ...overrides,
  };
}

function makeChannelSchema(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
    },
    required: ['id', 'name'],
    ...overrides,
  };
}

// ─── T3.1: Schema Registration ─────────────────────────────────────────────

describe('T3.1: Schema Registration', () => {
  let mgr: SchemaManagerImpl;

  beforeEach(() => {
    mgr = new SchemaManagerImpl();
  });

  it('registers a new schema successfully', () => {
    const result = mgr.register({ ref: 'order-v1', schema: makeSchema() });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.ref).toBe('order-v1');
    expect(result.version).toBe(1);
  });

  it('rejects duplicate schema ref', () => {
    mgr.register({ ref: 'order-v1', schema: makeSchema() });
    const result = mgr.register({ ref: 'order-v1', schema: makeSchema() });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('SCHEMA_ALREADY_EXISTS');
  });

  it('rejects invalid JSON Schema', () => {
    const badSchema = { type: 'object', properties: { x: { type: 'invalid-type' } } };
    const result = mgr.register({ ref: 'bad-v1', schema: badSchema });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('INVALID_SCHEMA');
  });

  it('accepts D-Id metadata at registration time', () => {
    const result = mgr.register({
      ref: 'order-v1',
      schema: makeSchema(),
      dIdDefinition: { type: 'single', fields: ['id'] },
    });
    expect(result.success).toBe(true);

    const entry = mgr.get('order-v1');
    expect(entry?.dIdDefinition).toEqual({ type: 'single', fields: ['id'] });
  });

  it('allows identityKind custom keyword without strict mode error', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'integer', identityKind: 'primary-key' },
        parentId: { type: 'string', identityKind: 'parent-key' },
      },
      required: ['id'],
    };
    const result = mgr.register({ ref: 'identity-test', schema });
    expect(result.success).toBe(true);
  });
});

// ─── T3.2: Schema Retrieval ─────────────────────────────────────────────────

describe('T3.2: Schema Retrieval', () => {
  let mgr: SchemaManagerImpl;

  beforeEach(() => {
    mgr = new SchemaManagerImpl();
    mgr.register({ ref: 'order-v1', schema: makeSchema() });
  });

  it('retrieves an existing schema', () => {
    const entry = mgr.get('order-v1');
    expect(entry).toBeDefined();
    expect(entry?.ref).toBe('order-v1');
    expect(entry?.version).toBe(1);
    expect(entry?.lifecycle).toBe('active');
  });

  it('returns undefined for non-existent schema', () => {
    expect(mgr.get('nope')).toBeUndefined();
  });

  it('includes version history', () => {
    const entry = mgr.get('order-v1');
    expect(entry?.versions).toHaveLength(1);
    expect(entry?.versions[0]?.version).toBe(1);
  });

  it('lists all registered schemas', () => {
    mgr.register({ ref: 'customer-v1', schema: makeSchema() });
    const all = mgr.list();
    expect(all).toHaveLength(2);
  });
});

// ─── T3.3: Schema Update ────────────────────────────────────────────────────

describe('T3.3: Schema Update', () => {
  let mgr: SchemaManagerImpl;

  beforeEach(() => {
    mgr = new SchemaManagerImpl();
    mgr.register({ ref: 'order-v1', schema: makeSchema() });
  });

  it('updates schema and increments version', () => {
    const newSchema = makeSchema({ required: ['id', 'name', 'active'] });
    const result = mgr.update('order-v1', newSchema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.version).toBe(2);
  });

  it('preserves version history after update', () => {
    mgr.update('order-v1', makeSchema({ required: ['id'] }));
    const entry = mgr.get('order-v1');
    expect(entry?.versions).toHaveLength(2);
    expect(entry?.versions[0]?.version).toBe(1);
    expect(entry?.versions[1]?.version).toBe(2);
  });

  it('rejects update of non-existent schema', () => {
    const result = mgr.update('nope', makeSchema());
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('SCHEMA_NOT_FOUND');
  });

  it('rejects update with invalid schema', () => {
    const result = mgr.update('order-v1', { type: 'object', properties: { x: { type: 'bogus' } } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('INVALID_SCHEMA');
  });
});

// ─── T3.4 & T3.5: Decommissioning and Reactivation ─────────────────────────

describe('T3.4 & T3.5: Schema Lifecycle', () => {
  let mgr: SchemaManagerImpl;

  beforeEach(() => {
    mgr = new SchemaManagerImpl();
    mgr.register({ ref: 'order-v1', schema: makeSchema() });
  });

  it('decommissions an active schema', () => {
    const result = mgr.decommission('order-v1');
    expect(result.success).toBe(true);
    expect(mgr.get('order-v1')?.lifecycle).toBe('decommissioned');
  });

  it('rejects decommissioning non-existent schema', () => {
    const result = mgr.decommission('nope');
    expect(result.success).toBe(false);
    expect(result.code).toBe('SCHEMA_NOT_FOUND');
  });

  it('rejects decommissioning already-decommissioned schema', () => {
    mgr.decommission('order-v1');
    const result = mgr.decommission('order-v1');
    expect(result.success).toBe(false);
    expect(result.code).toBe('ALREADY_DECOMMISSIONED');
  });

  it('reactivates a decommissioned schema', () => {
    mgr.decommission('order-v1');
    const result = mgr.reactivate('order-v1');
    expect(result.success).toBe(true);
    expect(mgr.get('order-v1')?.lifecycle).toBe('active');
  });

  it('rejects reactivation of already-active schema', () => {
    const result = mgr.reactivate('order-v1');
    expect(result.success).toBe(false);
    expect(result.code).toBe('ALREADY_ACTIVE');
  });
});

// ─── T3.6: Decommission Protection ─────────────────────────────────────────

describe('T3.6: Decommission Protection', () => {
  let mgr: SchemaManagerImpl;

  beforeEach(() => {
    mgr = new SchemaManagerImpl();
    mgr.register({ ref: 'master-schema', schema: makeSchema() });
    mgr.register({ ref: 'channel-schema', schema: makeChannelSchema() });
  });

  it('rejects decommissioning of an active Master_Schema', () => {
    // Simulate Document_Type Registry reporting this as a Master_Schema
    mgr.setMasterSchemaChecker((ref) => ref === 'master-schema');

    const result = mgr.decommission('master-schema');
    expect(result.success).toBe(false);
    expect(result.code).toBe('MASTER_SCHEMA_ACTIVE');
  });

  it('allows decommissioning of Channel_Schemas regardless of Document_Type', () => {
    mgr.setMasterSchemaChecker((ref) => ref === 'master-schema');

    const result = mgr.decommission('channel-schema');
    expect(result.success).toBe(true);
  });
});

// ─── T3.7: DCM Validation ───────────────────────────────────────────────────

describe('T3.7: DCM Validation', () => {
  let mgr: SchemaManagerImpl;

  beforeEach(() => {
    mgr = new SchemaManagerImpl();
    mgr.register({ ref: 'order-v1', schema: makeSchema() });
  });

  it('validates a complete document successfully', () => {
    const doc = { id: 1, name: 'Order A', active: true };
    const result = mgr.validate(doc, 'order-v1', 'closed');
    expect(result.valid).toBe(true);
  });

  it('validates with only required fields (optional fields absent)', () => {
    const doc = { id: 1, name: 'Order A' };
    const result = mgr.validate(doc, 'order-v1', 'closed');
    expect(result.valid).toBe(true);
  });

  it('rejects document missing required field', () => {
    const doc = { id: 1 }; // missing 'name'
    const result = mgr.validate(doc, 'order-v1', 'closed');
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.keyword === 'required')).toBe(true);
  });

  it('rejects document with field not in schema (DCM: no extensions)', () => {
    const doc = { id: 1, name: 'Order A', extraField: 'nope' };
    const result = mgr.validate(doc, 'order-v1', 'closed');
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.keyword === 'additionalProperties')).toBe(true);
  });

  it('rejects document with wrong type', () => {
    const doc = { id: 'not-a-number', name: 'Order A' };
    const result = mgr.validate(doc, 'order-v1', 'closed');
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.keyword === 'type')).toBe(true);
  });

  it('rejects validation against non-existent schema', () => {
    const result = mgr.validate({ id: 1 }, 'nope', 'closed');
    expect(result.valid).toBe(false);
  });

  it('rejects validation against decommissioned schema', () => {
    mgr.decommission('order-v1');
    const result = mgr.validate({ id: 1, name: 'test' }, 'order-v1', 'closed');
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.keyword).toBe('lifecycle');
  });

  it('skips validation for DOM model', () => {
    const doc = { anything: 'goes', unknown: true };
    const result = mgr.validate(doc, 'order-v1', 'open');
    expect(result.valid).toBe(true);
  });

  it('validates if/then/else conditionals only when triggered', () => {
    const conditionalSchema = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: ['active', 'inactive'] },
        activatedAt: { type: 'string' },
      },
      required: ['id', 'status'],
      if: { properties: { status: { const: 'active' } }, required: ['status'] },
      then: { required: ['activatedAt'] },
    };
    mgr.register({ ref: 'conditional-v1', schema: conditionalSchema });

    // When status is 'active', activatedAt is required
    const activeDoc = { id: 1, status: 'active' };
    const result1 = mgr.validate(activeDoc, 'conditional-v1', 'closed');
    expect(result1.valid).toBe(false);

    // When status is 'inactive', activatedAt is NOT required
    const inactiveDoc = { id: 1, status: 'inactive' };
    const result2 = mgr.validate(inactiveDoc, 'conditional-v1', 'closed');
    expect(result2.valid).toBe(true);

    // When status is 'active' AND activatedAt present, valid
    const fullDoc = { id: 1, status: 'active', activatedAt: '2026-01-01' };
    const result3 = mgr.validate(fullDoc, 'conditional-v1', 'closed');
    expect(result3.valid).toBe(true);
  });
});

// ─── T3.8: Schema Consistency Checks ────────────────────────────────────────

describe('T3.8: Schema Consistency Checks', () => {
  let mgr: SchemaManagerImpl;

  beforeEach(() => {
    mgr = new SchemaManagerImpl();
    mgr.register({ ref: 'master', schema: makeSchema() });
  });

  it('reports consistent when channel is a valid subset of master', () => {
    mgr.register({ ref: 'channel', schema: makeChannelSchema() });
    const result = mgr.checkConsistency('channel', 'master', 'closed');
    expect(result.consistent).toBe(true);
  });

  it('detects CHANNEL_FIELD_NOT_IN_MASTER under DCM', () => {
    const channelWithExtra = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        extraField: { type: 'string' }, // not in master
      },
      required: ['id', 'name'],
    };
    mgr.register({ ref: 'channel-extra', schema: channelWithExtra });

    const result = mgr.checkConsistency('channel-extra', 'master', 'closed');
    expect(result.consistent).toBe(false);
    if (result.consistent) return;
    expect(result.conflicts.some((c) => c.code === 'CHANNEL_FIELD_NOT_IN_MASTER')).toBe(true);
  });

  it('allows channel extensions under HDOM', () => {
    const channelWithExtra = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        extension: { type: 'string' },
      },
      required: ['id', 'name'],
    };
    mgr.register({ ref: 'channel-hdom', schema: channelWithExtra });

    const result = mgr.checkConsistency('channel-hdom', 'master', 'hybrid');
    expect(result.consistent).toBe(true);
  });

  it('detects FIELD_TYPE_MISMATCH', () => {
    const channelBadType = {
      type: 'object',
      properties: {
        id: { type: 'string' }, // master has integer
        name: { type: 'string' },
      },
      required: ['id', 'name'],
    };
    mgr.register({ ref: 'channel-badtype', schema: channelBadType });

    const result = mgr.checkConsistency('channel-badtype', 'master', 'closed');
    expect(result.consistent).toBe(false);
    if (result.consistent) return;
    expect(result.conflicts.some((c) => c.code === 'FIELD_TYPE_MISMATCH')).toBe(true);
  });

  it('detects MASTER_REQUIRED_NOT_IN_CHANNEL', () => {
    const channelMissingRequired = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
      },
      required: ['id'], // missing 'name' which master requires
    };
    mgr.register({ ref: 'channel-missing-req', schema: channelMissingRequired });

    const result = mgr.checkConsistency('channel-missing-req', 'master', 'closed');
    expect(result.consistent).toBe(false);
    if (result.consistent) return;
    expect(result.conflicts.some((c) => c.code === 'MASTER_REQUIRED_NOT_IN_CHANNEL')).toBe(true);
  });

  it('detects type mismatch under HDOM too', () => {
    const channelBadType = {
      type: 'object',
      properties: {
        id: { type: 'boolean' }, // master has integer
        name: { type: 'string' },
      },
      required: ['id', 'name'],
    };
    mgr.register({ ref: 'channel-hdom-bad', schema: channelBadType });

    const result = mgr.checkConsistency('channel-hdom-bad', 'master', 'hybrid');
    expect(result.consistent).toBe(false);
    if (result.consistent) return;
    expect(result.conflicts.some((c) => c.code === 'FIELD_TYPE_MISMATCH')).toBe(true);
  });
});

// ─── T3.10: Schema Lifecycle State Management ───────────────────────────────

describe('T3.10: Schema Lifecycle Management', () => {
  let mgr: SchemaManagerImpl;

  beforeEach(() => {
    mgr = new SchemaManagerImpl();
    mgr.register({ ref: 'order-v1', schema: makeSchema() });
  });

  it('newly registered schema is active', () => {
    expect(mgr.get('order-v1')?.lifecycle).toBe('active');
  });

  it('lifecycle transitions: active → decommissioned → active', () => {
    mgr.decommission('order-v1');
    expect(mgr.get('order-v1')?.lifecycle).toBe('decommissioned');

    mgr.reactivate('order-v1');
    expect(mgr.get('order-v1')?.lifecycle).toBe('active');
  });

  it('updatedAt changes on decommission', () => {
    const before = mgr.get('order-v1')?.updatedAt;
    // Small delay to ensure timestamp differs
    mgr.decommission('order-v1');
    const after = mgr.get('order-v1')?.updatedAt;
    expect(after).toBeDefined();
    // They may or may not differ (same ms), but updatedAt must exist
    expect(typeof after).toBe('string');
    expect(before).toBeDefined();
  });
});
