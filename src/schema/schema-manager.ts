/**
 * Schema Manager implementation (T3.1–T3.10)
 *
 * Manages JSON Schema Draft 7 registration, versioning, validation,
 * lifecycle (active/decommissioned), and consistency checks.
 *
 * Uses Ajv for JSON Schema validation. Supports the custom `identityKind`
 * annotation keyword (ignored by the validator, read by D-Id Extractor).
 *
 * Design reference: design.md § Schema Manager
 * Validates: Requirements 17, 20, 24, 29, 30, 31, 43, 46
 */

import AjvModule, { type ErrorObject, Ajv as AjvClass } from 'ajv';

// Handle Ajv's dual CJS/ESM export: at runtime the default may be the
// constructor directly or a namespace wrapper with .default.
const AjvConstructor: typeof AjvClass = (
  typeof (AjvModule as unknown as { default: unknown }).default === 'function'
    ? (AjvModule as unknown as { default: typeof AjvClass }).default
    : AjvModule as unknown as typeof AjvClass
);
import type { DocumentModel } from '../storage/types.js';
import type {
  ConsistencyConflict,
  ConsistencyResult,
  DecommissionResult,
  RegisterResult,
  RegisterSchemaOptions,
  SchemaEntry,
  SchemaManager,
  SchemaRef,
  SchemaVersion,
  ValidationError,
  ValidationResult,
} from './types.js';

export class SchemaManagerImpl implements SchemaManager {
  /** Schema repository: ref → entry. */
  private readonly schemas = new Map<string, SchemaEntry>();

  /** Ajv instance for JSON Schema Draft 7 validation. */
  private readonly ajv: AjvClass;

  /**
   * External checker for decommission protection (T3.6).
   * Provided by the Document_Type Registry (C4) to avoid circular deps.
   */
  private masterSchemaChecker: ((ref: SchemaRef) => boolean) | undefined;

  constructor() {
    this.ajv = new AjvConstructor({
      allErrors: true,
      strict: false, // Allow unknown keywords like identityKind
      validateFormats: false, // Skip format validation in Increment 1
    });
  }

  // ─── T3.1: Schema Registration ────────────────────────────────────────────

  register(options: RegisterSchemaOptions): RegisterResult {
    const { ref, schema, dIdDefinition } = options;

    if (this.schemas.has(ref)) {
      return { success: false, code: 'SCHEMA_ALREADY_EXISTS', message: `Schema '${ref}' already exists` };
    }

    // Compile to verify it's a valid JSON Schema
    try {
      this.ajv.compile(schema);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid JSON Schema';
      return { success: false, code: 'INVALID_SCHEMA', message };
    }

    const now = new Date().toISOString();
    const entry: SchemaEntry = {
      ref,
      schema,
      version: 1,
      versions: [{ version: 1, schema, timestamp: now }],
      lifecycle: 'active',
      ...(dIdDefinition !== undefined ? { dIdDefinition } : {}),
      createdAt: now,
      updatedAt: now,
    };

    this.schemas.set(ref, entry);
    return { success: true, ref, version: 1 };
  }

  // ─── T3.2: Schema Retrieval ───────────────────────────────────────────────

  get(ref: SchemaRef): SchemaEntry | undefined {
    return this.schemas.get(ref);
  }

  // ─── T3.3: Schema Update ──────────────────────────────────────────────────

  update(ref: SchemaRef, newSchema: Record<string, unknown>): RegisterResult {
    const entry = this.schemas.get(ref);
    if (!entry) {
      return { success: false, code: 'SCHEMA_NOT_FOUND', message: `Schema '${ref}' not found` };
    }

    // Compile to verify validity
    try {
      this.ajv.compile(newSchema);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid JSON Schema';
      return { success: false, code: 'INVALID_SCHEMA', message };
    }

    const now = new Date().toISOString();
    const newVersion = entry.version + 1;
    const versionEntry: SchemaVersion = { version: newVersion, schema: newSchema, timestamp: now };

    // Mutate the entry (it's mutable by design for lifecycle changes)
    const updated: SchemaEntry = {
      ...entry,
      schema: newSchema,
      version: newVersion,
      versions: [...entry.versions, versionEntry],
      updatedAt: now,
    };

    this.schemas.set(ref, updated);
    return { success: true, ref, version: newVersion };
  }

  // ─── T3.4: Schema Decommissioning ────────────────────────────────────────

  decommission(ref: SchemaRef): DecommissionResult {
    const entry = this.schemas.get(ref);
    if (!entry) {
      return { success: false, code: 'SCHEMA_NOT_FOUND', message: `Schema '${ref}' not found` };
    }

    if (entry.lifecycle === 'decommissioned') {
      return { success: false, code: 'ALREADY_DECOMMISSIONED', message: `Schema '${ref}' is already decommissioned` };
    }

    // T3.6: Decommission protection — reject if active Master_Schema
    if (this.isActiveMasterSchema(ref)) {
      return {
        success: false,
        code: 'MASTER_SCHEMA_ACTIVE',
        message: `Cannot decommission '${ref}': it is the Master_Schema of an active Document_Type`,
      };
    }

    entry.lifecycle = 'decommissioned';
    entry.updatedAt = new Date().toISOString();
    return { success: true };
  }

  // ─── T3.5: Schema Reactivation ───────────────────────────────────────────

  reactivate(ref: SchemaRef): DecommissionResult {
    const entry = this.schemas.get(ref);
    if (!entry) {
      return { success: false, code: 'SCHEMA_NOT_FOUND', message: `Schema '${ref}' not found` };
    }

    if (entry.lifecycle === 'active') {
      return { success: false, code: 'ALREADY_ACTIVE', message: `Schema '${ref}' is already active` };
    }

    entry.lifecycle = 'active';
    entry.updatedAt = new Date().toISOString();
    return { success: true };
  }

  // ─── T3.7: DCM Validation ────────────────────────────────────────────────

  validate(document: Record<string, unknown>, ref: SchemaRef, model: DocumentModel): ValidationResult {
    const entry = this.schemas.get(ref);
    if (!entry) {
      return { valid: false, errors: [{ path: '', message: `Schema '${ref}' not found`, keyword: 'schema' }] };
    }

    if (entry.lifecycle === 'decommissioned') {
      return { valid: false, errors: [{ path: '', message: `Schema '${ref}' is decommissioned`, keyword: 'lifecycle' }] };
    }

    // DOM: no validation
    if (model === 'open') {
      return { valid: true };
    }

    // Compile and validate with Ajv
    const errors: ValidationError[] = [];

    // For DCM: check no extra fields (additionalProperties enforcement)
    if (model === 'closed') {
      const dcmErrors = this.validateDCM(document, entry.schema);
      errors.push(...dcmErrors);
    }

    // Standard JSON Schema validation (required fields, types, constraints)
    const schemaErrors = this.validateWithAjv(document, entry.schema);
    errors.push(...schemaErrors);

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  // ─── T3.8: Schema Consistency Checks ──────────────────────────────────────

  checkConsistency(channelSchemaRef: SchemaRef, masterSchemaRef: SchemaRef, model: DocumentModel): ConsistencyResult {
    const channelEntry = this.schemas.get(channelSchemaRef);
    const masterEntry = this.schemas.get(masterSchemaRef);

    if (!channelEntry || !masterEntry) {
      return {
        consistent: false,
        conflicts: [{
          field: '',
          reason: 'One or both schemas not found',
          code: 'CHANNEL_FIELD_NOT_IN_MASTER',
        }],
      };
    }

    const conflicts = this.detectConsistencyConflicts(
      channelEntry.schema,
      masterEntry.schema,
      model,
    );

    if (conflicts.length > 0) {
      return { consistent: false, conflicts };
    }

    return { consistent: true };
  }

  // ─── T3.6: Master Schema Check ───────────────────────────────────────────

  isActiveMasterSchema(ref: SchemaRef): boolean {
    if (this.masterSchemaChecker) {
      return this.masterSchemaChecker(ref);
    }
    return false;
  }

  setMasterSchemaChecker(checker: (ref: SchemaRef) => boolean): void {
    this.masterSchemaChecker = checker;
  }

  // ─── List ─────────────────────────────────────────────────────────────────

  list(): SchemaEntry[] {
    return [...this.schemas.values()];
  }

  // ─── Private: DCM-specific validation ─────────────────────────────────────

  /**
   * DCM validation: reject fields not in the Master_Schema's properties.
   * This enforces the "closed" model — no extensions allowed.
   */
  private validateDCM(document: Record<string, unknown>, schema: Record<string, unknown>): ValidationError[] {
    const errors: ValidationError[] = [];
    const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
    const allowedFields = new Set(Object.keys(properties));

    for (const key of Object.keys(document)) {
      if (!allowedFields.has(key)) {
        errors.push({
          path: `/${key}`,
          message: `Field '${key}' is not defined in the schema (DCM: no extensions allowed)`,
          keyword: 'additionalProperties',
        });
      }
    }

    return errors;
  }

  /**
   * Validate document against schema using Ajv.
   * Handles required fields, type checks, constraints, if/then/else.
   */
  private validateWithAjv(document: Record<string, unknown>, schema: Record<string, unknown>): ValidationError[] {
    try {
      const validate = this.ajv.compile(schema);
      const valid = validate(document);

      if (valid) return [];

      return (validate.errors ?? []).map((err: ErrorObject) => ({
        path: err.instancePath || '/',
        message: err.message ?? 'Validation error',
        keyword: err.keyword,
      }));
    } catch (err) {
      return [{
        path: '',
        message: err instanceof Error ? err.message : 'Schema compilation error',
        keyword: 'schema',
      }];
    }
  }

  // ─── Private: Consistency conflict detection ──────────────────────────────

  /**
   * Detect conflicts between a Channel_Schema and a Master_Schema.
   *
   * Rules (from design.md):
   * - DCM: channel field NOT in master properties → CONFLICT
   * - DCM: channel required field NOT in master properties → CONFLICT
   * - Any model: field type mismatch → CONFLICT
   * - DCM/HDOM: master required field NOT required in channel → CONFLICT
   */
  private detectConsistencyConflicts(
    channelSchema: Record<string, unknown>,
    masterSchema: Record<string, unknown>,
    model: DocumentModel,
  ): ConsistencyConflict[] {
    const conflicts: ConsistencyConflict[] = [];

    const channelProps = (channelSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    const masterProps = (masterSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    const channelRequired = new Set((channelSchema['required'] ?? []) as string[]);
    const masterRequired = new Set((masterSchema['required'] ?? []) as string[]);

    // Check channel fields against master
    for (const [field, channelFieldSchema] of Object.entries(channelProps)) {
      const masterFieldSchema = masterProps[field];

      if (!masterFieldSchema) {
        // Channel field not in master
        if (model === 'closed') {
          conflicts.push({
            field,
            reason: `Channel field '${field}' is not defined in Master_Schema properties`,
            code: 'CHANNEL_FIELD_NOT_IN_MASTER',
          });
        }
        // HDOM: allowed (extension)
        continue;
      }

      // Type mismatch check (applies to all models)
      const channelType = channelFieldSchema['type'];
      const masterType = masterFieldSchema['type'];
      if (channelType && masterType && channelType !== masterType) {
        conflicts.push({
          field,
          reason: `Type mismatch: channel declares '${String(channelType)}', master declares '${String(masterType)}'`,
          code: 'FIELD_TYPE_MISMATCH',
        });
      }
    }

    // Check channel required fields against master (DCM only)
    if (model === 'closed') {
      for (const field of channelRequired) {
        if (!masterProps[field]) {
          conflicts.push({
            field,
            reason: `Channel requires field '${field}' which is not in Master_Schema properties`,
            code: 'CHANNEL_REQUIRED_NOT_IN_MASTER',
          });
        }
      }
    }

    // Check master required fields are required in channel (DCM/HDOM)
    if (model === 'closed' || model === 'hybrid') {
      for (const field of masterRequired) {
        if (!channelRequired.has(field)) {
          conflicts.push({
            field,
            reason: `Master requires field '${field}' but channel does not require it`,
            code: 'MASTER_REQUIRED_NOT_IN_CHANNEL',
          });
        }
      }
    }

    return conflicts;
  }

  // ─── Persistence: Restore ───────────────────────────────────────────────

  /**
   * Restore a schema entry from a persisted snapshot. Bypasses normal
   * registration validation (schema is assumed valid from prior session).
   */
  restoreEntry(entry: SchemaEntry): void {
    this.schemas.set(entry.ref, { ...entry });
    // Pre-compile the schema in Ajv for future validation calls
    try {
      this.ajv.compile(entry.schema);
    } catch {
      // Non-fatal: schema was valid when first registered
    }
  }
}
