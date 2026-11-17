/**
 * Unit tests for Component 6: D-Id Extractor
 *
 * Covers T6.1 (identityKind reader), T6.2 (metadata fallback),
 * T6.3 (precedence), T6.4 (assembly order), T6.5 (extraction),
 * T6.6 (reject when no definition), T6.7 (require primary-key),
 * T6.8 (registration warnings), T6.9 (single-key), T6.10 (composed).
 */

import { describe, it, expect } from 'vitest';
import { DIdExtractorImpl } from '../src/did/did-extractor.js';

const extractor = new DIdExtractorImpl();

// ─── Test Schemas ───────────────────────────────────────────────────────────

const singleKeySchema = {
  type: 'object',
  properties: {
    orderId: { type: 'integer', identityKind: 'primary-key' },
    name: { type: 'string' },
  },
  required: ['orderId', 'name'],
};

const composedSchema = {
  type: 'object',
  properties: {
    customerId: { type: 'integer', identityKind: 'parent-key' },
    orderId: { type: 'integer', identityKind: 'primary-key' },
    amount: { type: 'number' },
  },
  required: ['customerId', 'orderId'],
};

const multiPrimarySchema = {
  type: 'object',
  properties: {
    region: { type: 'string', identityKind: 'primary-key' },
    storeId: { type: 'string', identityKind: 'primary-key' },
    name: { type: 'string' },
  },
};

const noIdentitySchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' },
  },
};

const parentKeyOnlySchema = {
  type: 'object',
  properties: {
    region: { type: 'string', identityKind: 'parent-key' },
    name: { type: 'string' },
  },
};

// ─── T6.1: identityKind Annotation Reader ───────────────────────────────────

describe('T6.1: identityKind Reader', () => {
  it('detects primary-key fields', () => {
    const result = extractor.resolveDefinition(singleKeySchema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.fields).toHaveLength(1);
    expect(result.definition.fields[0]?.fieldName).toBe('orderId');
    expect(result.definition.fields[0]?.kind).toBe('primary-key');
  });

  it('detects parent-key and primary-key fields', () => {
    const result = extractor.resolveDefinition(composedSchema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.fields).toHaveLength(2);
  });

  it('ignores fields without identityKind', () => {
    const result = extractor.resolveDefinition(singleKeySchema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const fieldNames = result.definition.fields.map((f) => f.fieldName);
    expect(fieldNames).not.toContain('name');
  });
});

// ─── T6.2: Metadata Fallback ────────────────────────────────────────────────

describe('T6.2: Metadata Fallback', () => {
  it('uses metadata when no identityKind annotations present', () => {
    const result = extractor.resolveDefinition(noIdentitySchema, {
      type: 'single',
      fields: ['name'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.source).toBe('metadata');
    expect(result.definition.fields[0]?.fieldName).toBe('name');
  });

  it('uses metadata for composed key definition', () => {
    const result = extractor.resolveDefinition(noIdentitySchema, {
      type: 'composed',
      fields: ['name', 'age'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.type).toBe('composed');
    expect(result.definition.fields).toHaveLength(2);
  });
});

// ─── T6.3: Precedence Rule ─────────────────────────────────────────────────

describe('T6.3: Precedence Rule', () => {
  it('inline identityKind wins over metadata', () => {
    const result = extractor.resolveDefinition(singleKeySchema, {
      type: 'single',
      fields: ['name'], // conflicts with inline
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.source).toBe('identityKind');
    expect(result.definition.fields[0]?.fieldName).toBe('orderId');
  });

  it('warns on conflict between inline and metadata', () => {
    const result = extractor.resolveDefinition(singleKeySchema, {
      type: 'single',
      fields: ['name'], // conflicts
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings.some((w) => w.code === 'IDENTITY_KIND_METADATA_CONFLICT')).toBe(true);
  });

  it('no warning when inline and metadata agree', () => {
    const result = extractor.resolveDefinition(singleKeySchema, {
      type: 'single',
      fields: ['orderId'], // matches inline
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings.some((w) => w.code === 'IDENTITY_KIND_METADATA_CONFLICT')).toBe(false);
  });
});

// ─── T6.4: D-Id Assembly Order ──────────────────────────────────────────────

describe('T6.4: Assembly Order', () => {
  it('parent-keys first, then primary-keys (declaration order)', () => {
    const result = extractor.resolveDefinition(composedSchema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.fields[0]?.fieldName).toBe('customerId');
    expect(result.definition.fields[0]?.kind).toBe('parent-key');
    expect(result.definition.fields[1]?.fieldName).toBe('orderId');
    expect(result.definition.fields[1]?.kind).toBe('primary-key');
  });

  it('multiple primary-keys in declaration order', () => {
    const result = extractor.resolveDefinition(multiPrimarySchema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.fields[0]?.fieldName).toBe('region');
    expect(result.definition.fields[1]?.fieldName).toBe('storeId');
  });
});

// ─── T6.5: D-Id Extraction from Document ───────────────────────────────────

describe('T6.5: Extraction from Document', () => {
  it('extracts single-key D-Id', () => {
    const defResult = extractor.resolveDefinition(singleKeySchema);
    if (!defResult.success) return;

    const result = extractor.extract({ orderId: 42, name: 'Test' }, defResult.definition);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.dId).toEqual({ type: 'single', value: '42' });
  });

  it('extracts composed D-Id', () => {
    const defResult = extractor.resolveDefinition(composedSchema);
    if (!defResult.success) return;

    const result = extractor.extract(
      { customerId: 100, orderId: 200, amount: 50 },
      defResult.definition,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.dId).toEqual({ type: 'composed', parts: ['100', '200'] });
  });

  it('fails when identity field is missing', () => {
    const defResult = extractor.resolveDefinition(singleKeySchema);
    if (!defResult.success) return;

    const result = extractor.extract({ name: 'no id' }, defResult.definition);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('MISSING_IDENTITY_FIELD');
  });

  it('fails when identity field is null', () => {
    const defResult = extractor.resolveDefinition(singleKeySchema);
    if (!defResult.success) return;

    const result = extractor.extract({ orderId: null, name: 'test' }, defResult.definition);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('MISSING_IDENTITY_FIELD');
  });

  it('converts non-string values to strings', () => {
    const defResult = extractor.resolveDefinition(singleKeySchema);
    if (!defResult.success) return;

    const result = extractor.extract({ orderId: 123, name: 'test' }, defResult.definition);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.dId).toEqual({ type: 'single', value: '123' });
  });
});

// ─── T6.6: Reject When No D-Id Definition ──────────────────────────────────

describe('T6.6: No D-Id Definition', () => {
  it('rejects schema with no identityKind and no metadata', () => {
    const result = extractor.resolveDefinition(noIdentitySchema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('NO_DID_DEFINITION');
  });
});

// ─── T6.7: At Least One Primary-Key ────────────────────────────────────────

describe('T6.7: Require Primary-Key', () => {
  it('rejects schema with only parent-key (no primary-key)', () => {
    const result = extractor.resolveDefinition(parentKeyOnlySchema);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('NO_PRIMARY_KEY');
  });
});

// ─── T6.8: Registration Warnings ────────────────────────────────────────────

describe('T6.8: Registration Warnings', () => {
  it('warns COMPLEX_IDENTITY_COMPOSITION (2 parents + 2 primaries)', () => {
    const schema = {
      type: 'object',
      properties: {
        region: { type: 'string', identityKind: 'parent-key' },
        zone: { type: 'string', identityKind: 'parent-key' },
        store: { type: 'string', identityKind: 'primary-key' },
        counter: { type: 'string', identityKind: 'primary-key' },
      },
    };
    const result = extractor.resolveDefinition(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings.some((w) => w.code === 'COMPLEX_IDENTITY_COMPOSITION')).toBe(true);
  });

  it('warns LONG_COMPOSITE_DID (> 3 total parts)', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'string', identityKind: 'parent-key' },
        b: { type: 'string', identityKind: 'parent-key' },
        c: { type: 'string', identityKind: 'primary-key' },
        d: { type: 'string', identityKind: 'primary-key' },
      },
    };
    const result = extractor.resolveDefinition(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings.some((w) => w.code === 'LONG_COMPOSITE_DID')).toBe(true);
  });

  it('warns IDENTITY_ORDER_AMBIGUOUS (parent after primary)', () => {
    const schema = {
      type: 'object',
      properties: {
        orderId: { type: 'string', identityKind: 'primary-key' },
        customerId: { type: 'string', identityKind: 'parent-key' }, // declared after primary
      },
    };
    const result = extractor.resolveDefinition(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings.some((w) => w.code === 'IDENTITY_ORDER_AMBIGUOUS')).toBe(true);
  });

  it('no IDENTITY_ORDER_AMBIGUOUS when parent before primary', () => {
    const result = extractor.resolveDefinition(composedSchema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings.some((w) => w.code === 'IDENTITY_ORDER_AMBIGUOUS')).toBe(false);
  });
});

// ─── T6.9 & T6.10: Single and Composed D-Ids ───────────────────────────────

describe('T6.9 & T6.10: Single and Composed', () => {
  it('resolves single type for one primary-key, no parent-keys', () => {
    const result = extractor.resolveDefinition(singleKeySchema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.type).toBe('single');
  });

  it('resolves composed type for parent + primary', () => {
    const result = extractor.resolveDefinition(composedSchema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.type).toBe('composed');
  });

  it('resolves composed type for multiple primary-keys', () => {
    const result = extractor.resolveDefinition(multiPrimarySchema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.type).toBe('composed');
  });
});

// ─── Nested-path identityKind (universal, arbitrary object depth) ───────────

describe('Nested identityKind: recursive discovery', () => {
  // A single nested primary key.
  const nestedSingle = {
    type: 'object',
    properties: {
      Identifier: {
        type: 'object',
        properties: {
          Number: { type: 'string', identityKind: 'primary-key' },
        },
      },
      other: { type: 'string' },
    },
  };

  it('discovers a nested primary-key and records its full path', () => {
    const result = extractor.resolveDefinition(nestedSingle);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.definition.fields).toHaveLength(1);
    expect(result.definition.fields[0]?.path).toEqual(['Identifier', 'Number']);
    expect(result.definition.fields[0]?.fieldName).toBe('Identifier.Number');
    expect(result.definition.type).toBe('single');
  });

  it('extracts a nested single-key D-Id from a document', () => {
    const def = extractor.resolveDefinition(nestedSingle);
    if (!def.success) return;
    const result = extractor.extract({ Identifier: { Number: 'ECIS34549' }, other: 'x' }, def.definition);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.dId).toEqual({ type: 'single', value: 'ECIS34549' });
  });

  // The real Ebba consignment shape: composite key from two nested levels.
  const ebbaShape = {
    type: 'object',
    properties: {
      Identifier: {
        type: 'object',
        properties: {
          CreatorReference: {
            type: 'object',
            properties: {
              BusinessUnitCode: { type: 'string', identityKind: 'parent-key' },
              BusinessUnitType: { type: 'string', identityKind: 'parent-key' },
            },
          },
          Number: { type: 'string', identityKind: 'primary-key' },
        },
      },
    },
  };

  it('discovers nested parent-keys and primary-key in depth-first declaration order', () => {
    const result = extractor.resolveDefinition(ebbaShape);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const paths = result.definition.fields.map((f) => f.fieldName);
    // Parent-keys first (declaration order), then the primary-key.
    expect(paths).toEqual([
      'Identifier.CreatorReference.BusinessUnitCode',
      'Identifier.CreatorReference.BusinessUnitType',
      'Identifier.Number',
    ]);
    expect(result.definition.type).toBe('composed');
  });

  it('extracts the composite 3-part D-Id from an Ebba-shaped document', () => {
    const def = extractor.resolveDefinition(ebbaShape);
    if (!def.success) return;
    const doc = {
      Identifier: {
        CreatorReference: { BusinessUnitCode: '22648', BusinessUnitType: 'SUP' },
        Number: 'ECIS34549',
      },
    };
    const result = extractor.extract(doc, def.definition);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.dId).toEqual({ type: 'composed', parts: ['22648', 'SUP', 'ECIS34549'] });
  });

  it('resolves identityKind through $ref definitions', () => {
    const refSchema = {
      type: 'object',
      properties: {
        Identifier: { $ref: '#/definitions/identifierType' },
      },
      definitions: {
        identifierType: {
          type: 'object',
          properties: {
            Number: { type: 'string', identityKind: 'primary-key' },
          },
        },
      },
    };
    const def = extractor.resolveDefinition(refSchema);
    expect(def.success).toBe(true);
    if (!def.success) return;
    expect(def.definition.fields[0]?.fieldName).toBe('Identifier.Number');
    const result = extractor.extract({ Identifier: { Number: 'N-1' } }, def.definition);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.dId).toEqual({ type: 'single', value: 'N-1' });
  });

  it('does NOT descend into arrays (array-nested identityKind is not discovered)', () => {
    const arraySchema = {
      type: 'object',
      properties: {
        contents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              contentId: { type: 'string', identityKind: 'primary-key' },
            },
          },
        },
      },
    };
    const result = extractor.resolveDefinition(arraySchema);
    // No discoverable identity field -> no definition.
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('NO_DID_DEFINITION');
  });
});

describe('Nested identityKind: extraction failure modes', () => {
  const ebbaShape = {
    type: 'object',
    properties: {
      Identifier: {
        type: 'object',
        properties: {
          Number: { type: 'string', identityKind: 'primary-key' },
        },
      },
    },
  };

  it('reports MISSING_IDENTITY_FIELD when a mid-path object is absent', () => {
    const def = extractor.resolveDefinition(ebbaShape);
    if (!def.success) return;
    const result = extractor.extract({ somethingElse: true }, def.definition);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('MISSING_IDENTITY_FIELD');
    expect(result.message).toContain('Identifier.Number');
  });

  it('reports MISSING_IDENTITY_FIELD when the nested value is null', () => {
    const def = extractor.resolveDefinition(ebbaShape);
    if (!def.success) return;
    const result = extractor.extract({ Identifier: { Number: null } }, def.definition);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('MISSING_IDENTITY_FIELD');
  });

  it('reports IDENTITY_FIELD_NOT_SCALAR when the annotated leaf resolves to an object', () => {
    // Annotate an object-typed property directly.
    const schema = {
      type: 'object',
      properties: {
        Identifier: {
          type: 'object',
          identityKind: 'primary-key',
          properties: { Number: { type: 'string' } },
        },
      },
    };
    const def = extractor.resolveDefinition(schema);
    if (!def.success) return;
    const result = extractor.extract({ Identifier: { Number: 'x' } }, def.definition);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('IDENTITY_FIELD_NOT_SCALAR');
    expect(result.message).toContain('object');
  });

  it('reports IDENTITY_FIELD_NOT_SCALAR when the annotated leaf resolves to an array', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', identityKind: 'primary-key' },
      },
    };
    const def = extractor.resolveDefinition(schema);
    if (!def.success) return;
    const result = extractor.extract({ tags: ['a', 'b'] }, def.definition);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('IDENTITY_FIELD_NOT_SCALAR');
    expect(result.message).toContain('array');
  });
});

describe('Nested identityKind: warnings', () => {
  it('warns DEEPLY_NESTED_IDENTITY for a path deeper than 3 segments', () => {
    const schema = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            b: {
              type: 'object',
              properties: {
                c: {
                  type: 'object',
                  properties: {
                    d: { type: 'string', identityKind: 'primary-key' }, // path length 4
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = extractor.resolveDefinition(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings.some((w) => w.code === 'DEEPLY_NESTED_IDENTITY')).toBe(true);
  });

  it('does not warn DEEPLY_NESTED_IDENTITY for a 3-segment path', () => {
    const schema = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            b: {
              type: 'object',
              properties: {
                c: { type: 'string', identityKind: 'primary-key' }, // path length 3
              },
            },
          },
        },
      },
    };
    const result = extractor.resolveDefinition(schema);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings.some((w) => w.code === 'DEEPLY_NESTED_IDENTITY')).toBe(false);
  });
});

describe('Nested identityKind: metadata fallback with dotted paths', () => {
  it('splits a dotted metadata field reference into a nested path', () => {
    const noAnnotations = {
      type: 'object',
      properties: {
        Identifier: {
          type: 'object',
          properties: { Number: { type: 'string' } },
        },
      },
    };
    const def = extractor.resolveDefinition(noAnnotations, { type: 'single', fields: ['Identifier.Number'] });
    expect(def.success).toBe(true);
    if (!def.success) return;
    expect(def.definition.source).toBe('metadata');
    expect(def.definition.fields[0]?.path).toEqual(['Identifier', 'Number']);
    const result = extractor.extract({ Identifier: { Number: 'M-9' } }, def.definition);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.dId).toEqual({ type: 'single', value: 'M-9' });
  });
});
