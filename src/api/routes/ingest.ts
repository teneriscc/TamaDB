/**
 * Ingestion routes (T15.1)
 *
 * POST /api/v1/ingest/{documentType}
 * POST /api/v1/ingest/{documentType}/{channelId}
 *
 * The HTTP handlers here are a THIN ADAPTER. All ingest logic lives in the
 * framework-agnostic `runIngest` pipeline entry below, which takes plain inputs
 * (raw body string, a header map, the ingest path) and returns a typed
 * `IngestOutcome` with no Fastify types. This keeps the HTTP layer swappable
 * (e.g. for a future Rust reimplementation using a different web framework) —
 * see design.md "Framework-Agnostic Ingest Boundary".
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import type { StoreRequest } from '../../document-manager/types.js';
import type { RejectionType } from '../../quarantine/types.js';
import { httpStatusForCode, buildErrorResponse } from '../errors.js';

/** A framework-agnostic header map (Fastify's request.headers satisfies this). */
export type HeaderMap = Record<string, string | string[] | undefined>;

/**
 * The reserved TamaDB-* Control_Header names (Req 34.11). HTTP header names are
 * case-insensitive; Fastify lowercases them, so we read the lowercased keys.
 */
const CONTROL_HEADER = {
  version: 'tamadb-version',
  ttl: 'tamadb-ttl',
  expireAt: 'tamadb-expire-at',
  schema: 'tamadb-schema',
} as const;

/** Canonical display names for the reserved control headers (for audit capture). */
const CONTROL_HEADER_CANONICAL: Record<string, string> = {
  [CONTROL_HEADER.version]: 'TamaDB-Version',
  [CONTROL_HEADER.ttl]: 'TamaDB-TTL',
  [CONTROL_HEADER.expireAt]: 'TamaDB-Expire-At',
  [CONTROL_HEADER.schema]: 'TamaDB-Schema',
};

// ─── Framework-agnostic ingest boundary ──────────────────────────────────────

/** Plain input to the ingest pipeline — no framework types. */
export interface IngestInput {
  /** The raw request body exactly as received (may be malformed / non-JSON). */
  readonly rawBody: string;
  /** Request headers (lowercased keys). */
  readonly headers: HeaderMap;
  /** The ingest path, e.g. `/api/v1/ingest/{documentType}[/{channelId}]`. */
  readonly path: string;
}

/** Typed outcome of the ingest pipeline — mapped to HTTP by the thin adapter. */
export type IngestOutcome =
  | {
      readonly ok: true;
      readonly status: 201 | 200;
      readonly dId: string | readonly string[];
      readonly versionNo: number;
      readonly created: boolean;
      readonly warning?: { readonly code: string; readonly message: string };
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly quarantineRef?: string;
    };

/** Read a single header value as a string (headers may present string | string[]). */
function headerValue(headers: HeaderMap, name: string): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * True if an ISO-8601 / RFC 3339 date-time string carries an explicit timezone
 * designator: a trailing `Z`/`z` (UTC) or a numeric offset `±HH:MM` / `±HHMM`
 * / `±HH`. A bare date (`2026-12-31`) or a timezone-less date-time
 * (`2026-12-31T23:59:59`) returns false — those are ambiguous (server-local)
 * and are rejected for TamaDB-Expire-At (Req 34.13).
 */
function hasExplicitTimezone(value: string): boolean {
  const s = value.trim();
  // Trailing 'Z' / 'z' means UTC.
  if (/[Zz]$/.test(s)) return true;
  // Numeric offset must appear in the TIME portion (after a 'T'/space), so we
  // don't mistake the date separators (the '-' in 2026-12-31) for an offset.
  const timeSep = Math.max(s.lastIndexOf('T'), s.lastIndexOf('t'), s.lastIndexOf(' '));
  if (timeSep < 0) return false; // date only, no time component → no timezone
  const timePart = s.slice(timeSep + 1);
  // e.g. 23:59:59+02:00 | 23:59:59-0500 | 23:59:59+02
  return /[+-]\d{2}(:?\d{2})?$/.test(timePart);
}

/**
 * Capture the request's TamaDB-* Control_Headers VERBATIM (raw strings, pre-coercion),
 * scoped strictly to the reserved namespace, for quarantine audit (Req 17.9a).
 * Keys are normalised to their canonical `TamaDB-*` form; absent headers yield {}.
 */
function captureControlHeaders(headers: HeaderMap): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const [lower, canon] of Object.entries(CONTROL_HEADER_CANONICAL)) {
    const v = headerValue(headers, lower);
    if (v !== undefined) captured[canon] = v;
  }
  return captured;
}

/** Result of parsing/validating the control headers into store-request fields. */
type ControlParse =
  | { ok: true; versionNo?: number; ttl?: number | 'infinite'; expireAt?: string; schema?: string }
  | { ok: false; header: string; message: string };

/**
 * Parse and validate the optional TamaDB-* Control_Headers (Req 34.11–15).
 * Out-of-domain values are rejected (never coerced, never silently ignored).
 */
function parseControlHeaders(headers: HeaderMap): ControlParse {
  const out: { versionNo?: number; ttl?: number | 'infinite'; expireAt?: string; schema?: string } = {};

  // TamaDB-Version: positive integer (>= 1). versionNo starts at 1 and only increments.
  const vRaw = headerValue(headers, CONTROL_HEADER.version);
  if (vRaw !== undefined) {
    if (!/^\d+$/.test(vRaw)) {
      return { ok: false, header: 'TamaDB-Version', message: 'expected a positive integer' };
    }
    const v = Number.parseInt(vRaw, 10);
    if (v < 1) {
      return { ok: false, header: 'TamaDB-Version', message: 'expected a positive integer (>= 1)' };
    }
    out.versionNo = v;
  }

  // TamaDB-TTL: non-negative integer seconds, or the literal "infinite".
  const tRaw = headerValue(headers, CONTROL_HEADER.ttl);
  if (tRaw !== undefined) {
    if (tRaw === 'infinite') {
      out.ttl = 'infinite';
    } else if (/^\d+$/.test(tRaw)) {
      out.ttl = Number.parseInt(tRaw, 10);
    } else {
      return { ok: false, header: 'TamaDB-TTL', message: 'expected a non-negative integer number of seconds or "infinite"' };
    }
  }

  // TamaDB-Expire-At: ISO-8601 / RFC 3339 date-time WITH an explicit timezone.
  // A timezone-less value is rejected: in a (future) multi-node deployment it
  // would be interpreted relative to each node's local time, making the expiry
  // instant non-deterministic across the cluster (Req 34.13). We require the
  // value to both parse AND carry a trailing 'Z'/'z' or a ±HH[:]MM offset.
  const eRaw = headerValue(headers, CONTROL_HEADER.expireAt);
  if (eRaw !== undefined) {
    const EXPIRE_AT_MESSAGE =
      'expected an ISO-8601 / RFC 3339 date-time with an explicit timezone (a trailing "Z" or a ±HH:MM offset), e.g. 2026-12-31T23:59:59Z';
    const ms = Date.parse(eRaw);
    if (Number.isNaN(ms)) {
      return { ok: false, header: 'TamaDB-Expire-At', message: EXPIRE_AT_MESSAGE };
    }
    if (!hasExplicitTimezone(eRaw)) {
      return { ok: false, header: 'TamaDB-Expire-At', message: EXPIRE_AT_MESSAGE };
    }
    out.expireAt = eRaw;
  }

  // TamaDB-Schema: non-empty schemaRef string (explicit Storage_Schema override).
  const sRaw = headerValue(headers, CONTROL_HEADER.schema);
  if (sRaw !== undefined) {
    if (sRaw.trim() === '') {
      return { ok: false, header: 'TamaDB-Schema', message: 'expected a non-empty schema reference' };
    }
    out.schema = sRaw;
  }

  return { ok: true, ...out };
}

/** Map store/parse error codes to quarantine rejection types. */
function toRejectionType(code: string): RejectionType | undefined {
  switch (code) {
    case 'PARSE_ERROR': return 'parse-error';
    case 'SCHEMA_VALIDATION_FAILED': return 'validation-failure';
    case 'ENRICHMENT_CONFLICT': return 'enrichment-conflict';
    default: return undefined;
  }
}

/**
 * The framework-agnostic ingest pipeline entry.
 *
 * Stages (all owned by TamaDB, none by the HTTP framework):
 *   1. Parse Control_Headers (Req 34) — reject INVALID_CONTROL_HEADER.
 *   2. Parse Raw_Payload -> Parsed_Payload — reject PARSE_ERROR on malformed JSON.
 *   3. Resolve channel/schema from the path.
 *   4. Store (enrich -> extract D-Id -> validate -> merge) via the Document Manager.
 *   5. On any rejection, quarantine per policy (capturing TamaDB-* headers for audit).
 *
 * Returns a typed IngestOutcome; the HTTP handler maps it to a response.
 */
export function runIngest(ctx: AppContext, input: IngestInput): IngestOutcome {
  const { rawBody, headers, path } = input;

  // Helper: apply quarantine policy and build the failure outcome.
  const fail = (code: string, message: string, quarantinePayload: unknown, sourceIdentifier: string, schemaRef?: string): IngestOutcome => {
    const rejectionType = toRejectionType(code);
    let quarantineRef: string | undefined;
    if (rejectionType && ctx.quarantineStore.shouldQuarantine(rejectionType)) {
      quarantineRef = ctx.quarantineStore.quarantine(quarantinePayload, {
        receivedAt: new Date().toISOString(),
        sourceIdentifier,
        ...(schemaRef !== undefined ? { schemaRef } : {}),
        rejectionReason: message,
        rejectionType,
        controlHeaders: captureControlHeaders(headers),
      });
    }
    return { ok: false, code, message, ...(quarantineRef ? { quarantineRef } : {}) };
  };

  // Step 1: Control_Headers (Req 34.11–15). Rejected before any store/quarantine.
  const control = parseControlHeaders(headers);
  if (!control.ok) {
    return { ok: false, code: 'INVALID_CONTROL_HEADER', message: `Invalid value for header ${control.header}: ${control.message}` };
  }

  // Step 2: Parse Raw_Payload -> Parsed_Payload (Req 25 / 17.7).
  // The whole body is the bare document (Req 1.9–1.10).
  let document: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // Valid JSON but not an object -> not a document.
      return fail('PARSE_ERROR', 'Request body must be a JSON object (the document)', rawBody, 'default');
    }
    document = parsed as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'malformed JSON';
    return fail('PARSE_ERROR', `Malformed JSON in request body: ${detail}`, rawBody, 'default');
  }

  // Step 3: Resolve channel / applicable schema.
  const resolution = ctx.channelResolver.resolve(path, control.schema ? { schema: control.schema } : undefined);
  if (!resolution.success) {
    // Resolution failures (DOCUMENT_TYPE_NOT_FOUND / CHANNEL_NOT_FOUND / inactive / blocked)
    // are not payload errors; quarantine only under all-rejections.
    return fail(resolution.code, resolution.message, document, 'default');
  }

  // Step 4: Store (enrichment -> D-Id -> validation -> merge).
  const storeReq: StoreRequest = {
    document,
    ...(control.versionNo !== undefined ? { versionNo: control.versionNo } : {}),
    ...(control.ttl !== undefined ? { ttl: control.ttl } : {}),
    ...(control.expireAt !== undefined ? { expireAt: control.expireAt } : {}),
  };
  const result = ctx.documentManager.store(storeReq, resolution.resolution);

  if (!result.success) {
    return fail(result.code, result.message, document, resolution.resolution.channelId ?? 'default', resolution.resolution.applicableSchema);
  }

  return {
    ok: true,
    status: result.created ? 201 : 200,
    dId: result.dId.type === 'single' ? result.dId.value : result.dId.parts,
    versionNo: result.versionNo,
    created: result.created,
    ...(result.warning ? { warning: result.warning } : {}),
  };
}

// ─── HTTP adapter (Fastify) ───────────────────────────────────────────────────

/** Coerce the raw body (string from the custom parser, or already-parsed) to a string. */
function rawBodyString(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body === undefined || body === null) return '';
  // Defensive: if some other content-type parser produced an object, re-serialise.
  return JSON.stringify(body);
}

export function registerIngestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const send = (reply: FastifyReply, outcome: IngestOutcome): FastifyReply => {
    if (outcome.ok) {
      return reply.status(outcome.status).send({
        dId: outcome.dId,
        versionNo: outcome.versionNo,
        created: outcome.created,
        ...(outcome.warning ? { warning: outcome.warning } : {}),
      });
    }
    return reply.status(httpStatusForCode(outcome.code)).send(
      buildErrorResponse(outcome.code, outcome.message, outcome.quarantineRef ? { quarantineRef: outcome.quarantineRef } : undefined),
    );
  };

  // Register the ingest routes inside an ENCAPSULATED plugin so their custom
  // raw-string body parser applies ONLY here — every other route keeps
  // Fastify's default JSON parsing. (Content-type parsers are scoped to the
  // Fastify context they are registered on.)
  //
  // The raw-string parser hands TamaDB the unparsed body so JSON parsing is a
  // TamaDB pipeline stage (Raw_Payload -> Parsed_Payload); a malformed body
  // then becomes a PARSE_ERROR that is quarantined per policy, instead of
  // Fastify rejecting it with FST_ERR_CTP_INVALID_JSON_BODY before the handler
  // runs. See design.md "Framework-Agnostic Ingest Boundary".
  void app.register(async (ingest) => {
    ingest.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      // Never throw: pass the raw payload through verbatim.
      done(null, body);
    });

    // POST /api/v1/ingest/:documentType
    ingest.post<{ Params: { documentType: string }; Body: unknown }>(
      '/api/v1/ingest/:documentType',
      async (request, reply) => {
        const { documentType } = request.params;
        const outcome = runIngest(ctx, {
          rawBody: rawBodyString(request.body),
          headers: request.headers,
          path: `/api/v1/ingest/${documentType}`,
        });
        return send(reply, outcome);
      },
    );

    // POST /api/v1/ingest/:documentType/:channelId
    ingest.post<{ Params: { documentType: string; channelId: string }; Body: unknown }>(
      '/api/v1/ingest/:documentType/:channelId',
      async (request, reply) => {
        const { documentType, channelId } = request.params;
        const outcome = runIngest(ctx, {
          rawBody: rawBodyString(request.body),
          headers: request.headers,
          path: `/api/v1/ingest/${documentType}/${channelId}`,
        });
        return send(reply, outcome);
      },
    );
  });
}
