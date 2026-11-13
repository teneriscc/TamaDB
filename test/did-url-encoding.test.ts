/**
 * Unit tests for D-Id URL encoding/decoding (src/api/context.ts).
 *
 * Composed D-Ids appear in URL paths as `part1:part2:...`. Parts are
 * percent-encoded so that a part value may legitimately contain the delimiter
 * ':' or the path separator '/', or '%', without corrupting part boundaries or
 * breaking router path matching. These tests assert lossless round-tripping.
 */

import { describe, it, expect } from 'vitest';
import { parseDIdFromUrl, dIdToUrl, encodeDIdPart, decodeDIdPart } from '../src/api/context.js';

const DELIM = ':';

describe('D-Id part encoding', () => {
  it('encodes the delimiter so it cannot be mistaken for a separator', () => {
    expect(encodeDIdPart('a:b')).toBe('a%3Ab');
    expect(decodeDIdPart('a%3Ab')).toBe('a:b');
  });

  it("encodes '/' so it cannot break path routing", () => {
    expect(encodeDIdPart('a/b')).toBe('a%2Fb');
    expect(decodeDIdPart('a%2Fb')).toBe('a/b');
  });

  it("encodes '%' safely", () => {
    expect(encodeDIdPart('50%')).toBe('50%25');
    expect(decodeDIdPart('50%25')).toBe('50%');
  });

  it('leaves plain business values unchanged', () => {
    expect(encodeDIdPart('ECIS34549')).toBe('ECIS34549');
    expect(encodeDIdPart('22648')).toBe('22648');
    expect(encodeDIdPart('SUP')).toBe('SUP');
  });
});

describe('single D-Id round-trip', () => {
  it('round-trips a plain single key', () => {
    const url = dIdToUrl({ type: 'single', value: 'ECIS34549' }, DELIM);
    expect(url).toBe('ECIS34549');
    expect(parseDIdFromUrl(url, DELIM)).toEqual({ type: 'single', value: 'ECIS34549' });
  });

  it('round-trips a single key that contains the delimiter', () => {
    const original = 'urn:ns:12345';
    const url = dIdToUrl({ type: 'single', value: original }, DELIM);
    // Encoded ':' means this stays a SINGLE key, not a composed one.
    expect(url).toBe('urn%3Ans%3A12345');
    expect(parseDIdFromUrl(url, DELIM)).toEqual({ type: 'single', value: original });
  });
});

describe('composed D-Id round-trip', () => {
  it('round-trips the Ebba 3-part D-Id', () => {
    const parts = ['22648', 'SUP', 'ECIS34549'];
    const url = dIdToUrl({ type: 'composed', parts }, DELIM);
    expect(url).toBe('22648:SUP:ECIS34549');
    expect(parseDIdFromUrl(url, DELIM)).toEqual({ type: 'composed', parts });
  });

  it('round-trips composed parts that themselves contain the delimiter', () => {
    const parts = ['a:b', 'c', 'd:e:f'];
    const url = dIdToUrl({ type: 'composed', parts }, DELIM);
    // Only the separators between parts are literal ':'; in-value ':' is encoded.
    expect(url).toBe('a%3Ab:c:d%3Ae%3Af');
    expect(parseDIdFromUrl(url, DELIM)).toEqual({ type: 'composed', parts });
  });

  it("round-trips composed parts containing '/'", () => {
    const parts = ['region/north', 'store-1'];
    const url = dIdToUrl({ type: 'composed', parts }, DELIM);
    expect(url).toBe('region%2Fnorth:store-1');
    expect(parseDIdFromUrl(url, DELIM)).toEqual({ type: 'composed', parts });
  });

  it('preserves part count under adversarial values', () => {
    const parts = ['::', ':', 'x'];
    const url = dIdToUrl({ type: 'composed', parts }, DELIM);
    const parsed = parseDIdFromUrl(url, DELIM);
    expect(parsed.type).toBe('composed');
    if (parsed.type !== 'composed') return;
    expect(parsed.parts).toHaveLength(3);
    expect(parsed.parts).toEqual(parts);
  });
});

describe('malformed percent-encoding is tolerated (no throw)', () => {
  it('returns the raw segment when decode fails', () => {
    expect(decodeDIdPart('%zz')).toBe('%zz');
    expect(() => parseDIdFromUrl('%zz', DELIM)).not.toThrow();
  });
});
