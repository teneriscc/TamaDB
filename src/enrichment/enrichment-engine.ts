/**
 * Enrichment Engine implementation (T17.1–T17.23)
 *
 * Manages per-channel enrichment bindings, executes the enrichment
 * pipeline step (Parsed_Payload → Enriched_Document), detects conflicts,
 * and applies configurable policies.
 *
 * Design reference: design.md § Enrichment Engine
 * Validates: Requirements 48.1–48.24
 */

import type {
  BindingRegistrationResult,
  EnrichmentBinding,
  EnrichmentConflict,
  EnrichmentConsistencyResult,
  EnrichmentEngine,
  EnrichmentPolicies,
  EnrichmentResult,
} from './types.js';

export class EnrichmentEngineImpl implements EnrichmentEngine {
  /** Per-channel bindings: channelId → bindings array. */
  private readonly bindings = new Map<string, EnrichmentBinding[]>();

  /** Instance-level policies (T17.16: defaults). */
  private policies: EnrichmentPolicies = {
    precedence: 'environment-over-content',
    conflictResolution: 'accept-and-warn',
  };

  // ─── T17.1, T17.2: Binding Registration ────────────────────────────────

  registerBindings(channelId: string, bindings: readonly EnrichmentBinding[]): BindingRegistrationResult {
    if (bindings.length === 0) {
      return { success: false, code: 'EMPTY_BINDINGS', message: 'No bindings provided' };
    }

    // Validate fieldPaths are non-empty
    for (const binding of bindings) {
      if (!binding.fieldPath || binding.fieldPath.trim().length === 0) {
        return {
          success: false,
          code: 'INVALID_FIELD_PATH',
          message: 'Binding fieldPath must be non-empty',
        };
      }
    }

    this.bindings.set(channelId, [...bindings]);
    return { success: true, dIdClassification: 'native' }; // Classification updated by caller with identity fields
  }

  // ─── T17.6: Binding Retrieval ──────────────────────────────────────────

  getBindings(channelId: string): readonly EnrichmentBinding[] {
    return this.bindings.get(channelId) ?? [];
  }

  // ─── T17.7: Binding Deletion ───────────────────────────────────────────

  deleteBindings(channelId: string): boolean {
    return this.bindings.delete(channelId);
  }

  // ─── T17.9–T17.14: Enrichment Pipeline Step ───────────────────────────

  enrich(parsedPayload: Record<string, unknown>, channelId: string): EnrichmentResult {
    const channelBindings = this.bindings.get(channelId);

    // T17.10: No-op pass-through when no bindings
    if (!channelBindings || channelBindings.length === 0) {
      return {
        enrichedDocument: { ...parsedPayload },
        conflicts: [],
        outcome: 'success',
        dIdClassification: 'native',
      };
    }

    const enrichedDocument = { ...parsedPayload };
    const conflicts: EnrichmentConflict[] = [];

    for (const binding of channelBindings) {
      const fieldPath = binding.fieldPath;
      const enrichedValue = binding.staticValue;
      const existsInPayload = fieldPath in parsedPayload;

      if (existsInPayload) {
        const payloadValue = parsedPayload[fieldPath];

        // T17.12: Same-value = no conflict
        if (deepEqual(payloadValue, enrichedValue)) {
          // No conflict, enrichment value == payload value
          enrichedDocument[fieldPath] = enrichedValue;
          continue;
        }

        // T17.11: Conflict detected — differing values
        const winner = this.policies.precedence === 'environment-over-content'
          ? 'environment' as const
          : 'content' as const;

        conflicts.push({
          fieldPath,
          enrichedValue,
          payloadValue,
          winner,
        });

        // T17.13: Apply winning value
        if (winner === 'environment') {
          enrichedDocument[fieldPath] = enrichedValue;
        }
        // If winner === 'content', payload value stays (already in enrichedDocument)
      } else {
        // No conflict — field not in payload, inject binding value
        enrichedDocument[fieldPath] = enrichedValue;
      }
    }

    // T17.14: Apply conflict resolution policy
    if (conflicts.length > 0 && this.policies.conflictResolution === 'discard-and-error') {
      // T17.20: Reject entire payload
      return {
        enrichedDocument: parsedPayload, // Return original (not enriched)
        conflicts,
        outcome: 'rejected',
        dIdClassification: 'native',
      };
    }

    // T17.21: accept-and-warn (or no conflicts)
    return {
      enrichedDocument,
      conflicts,
      outcome: 'success',
      dIdClassification: 'native', // Caller updates based on identity field analysis
    };
  }

  // ─── T17.4: Channel_Schema Consistency Check ──────────────────────────

  checkConsistency(
    channelId: string,
    channelSchemaProperties: Record<string, unknown>,
  ): EnrichmentConsistencyResult {
    const channelBindings = this.bindings.get(channelId);
    if (!channelBindings || channelBindings.length === 0) {
      return { consistent: true };
    }

    const propertyNames = new Set(Object.keys(channelSchemaProperties));
    const missingFields: string[] = [];

    for (const binding of channelBindings) {
      if (!propertyNames.has(binding.fieldPath)) {
        missingFields.push(binding.fieldPath);
      }
    }

    if (missingFields.length > 0) {
      return { consistent: false, missingFields };
    }

    return { consistent: true };
  }

  // ─── T17.15, T17.16: Policy Management ────────────────────────────────

  getPolicies(): EnrichmentPolicies {
    return { ...this.policies };
  }

  setPolicies(policies: Partial<EnrichmentPolicies>): void {
    if (policies.precedence !== undefined) {
      this.policies.precedence = policies.precedence;
    }
    if (policies.conflictResolution !== undefined) {
      this.policies.conflictResolution = policies.conflictResolution;
    }
  }

  // ─── T17.8: Foreign D-Id Classification ───────────────────────────────

  classifyDId(
    channelId: string,
    identityFields: readonly string[],
  ): 'native' | 'foreign' {
    const channelBindings = this.bindings.get(channelId);
    if (!channelBindings || channelBindings.length === 0) {
      return 'native';
    }

    const identitySet = new Set(identityFields);
    for (const binding of channelBindings) {
      if (identitySet.has(binding.fieldPath)) {
        return 'foreign';
      }
    }

    return 'native';
  }

  // ─── Persistence: Snapshot & Restore ────────────────────────────────────

  snapshot(): { bindings: Array<{ channelId: string; bindings: EnrichmentBinding[] }>; policies: EnrichmentPolicies } {
    const bindingsArray: Array<{ channelId: string; bindings: EnrichmentBinding[] }> = [];
    for (const [channelId, b] of this.bindings) {
      bindingsArray.push({ channelId, bindings: [...b] });
    }
    return {
      bindings: bindingsArray,
      policies: { ...this.policies },
    };
  }

  restoreState(state: { bindings: Array<{ channelId: string; bindings: EnrichmentBinding[] }>; policies: EnrichmentPolicies }): void {
    this.bindings.clear();
    for (const entry of state.bindings) {
      this.bindings.set(entry.channelId, [...entry.bindings]);
    }
    this.policies = { ...state.policies };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Simple deep equality check for conflict detection (T17.12).
 * Handles primitives, arrays, and plain objects.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => deepEqual(val, b[idx]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}
