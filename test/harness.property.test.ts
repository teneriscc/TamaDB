import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

/**
 * Smoke test for the property-based testing harness (fast-check + Vitest).
 *
 * This proves T0.2 (property-based test framework wired up). The real
 * property suites (e.g. JSON round-trip, Property 5/6 in C1) will follow the
 * same pattern. We assert a trivial-but-real property here: JSON round-trips
 * through stringify/parse for arbitrary JSON-compatible values.
 */
describe('property-based harness', () => {
  it('JSON.parse(JSON.stringify(x)) deep-equals x for arbitrary JSON values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const roundTripped = JSON.parse(JSON.stringify(value));
        // Use JSON.stringify comparison because JSON spec treats -0 and 0 identically.
        expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(value));
      }),
    );
  });
});
