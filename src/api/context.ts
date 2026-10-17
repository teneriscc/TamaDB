/**
 * API Context — shared application state for all route handlers.
 *
 * Holds references to all domain components, initialized at startup.
 * Route plugins receive this context via Fastify's decorate mechanism.
 */

import type { StorageAdapter } from '../storage/types.js';
import type { SchemaManager } from '../schema/types.js';
import type { DocumentTypeRegistry } from '../document-type/types.js';
import type { ChannelResolver } from '../channel/types.js';
import type { DIdExtractor } from '../did/types.js';
import type { VersionManager } from '../version/types.js';
import type { EnrichmentEngine } from '../enrichment/types.js';
import type { DocumentManager } from '../document-manager/types.js';
import type { QueryEngine } from '../query/types.js';
import type { TtlManager } from '../ttl/types.js';
import type { QuarantineStore } from '../quarantine/types.js';
import type { SubscriptionManager } from '../subscription/types.js';
import type { WebhookDispatcher } from '../webhook/types.js';
import type { StorageManager } from '../storage/storage-manager.js';
import type { PersistenceCoordinator } from '../persistence/persistence-coordinator.js';

export interface AppContext {
  storage: StorageAdapter;
  storageManager: StorageManager;
  schemaManager: SchemaManager;
  docTypeRegistry: DocumentTypeRegistry;
  channelResolver: ChannelResolver;
  didExtractor: DIdExtractor;
  versionManager: VersionManager;
  enrichmentEngine: EnrichmentEngine;
  documentManager: DocumentManager;
  queryEngine: QueryEngine;
  ttlManager: TtlManager;
  quarantineStore: QuarantineStore;
  subscriptionManager: SubscriptionManager;
  webhookDispatcher: WebhookDispatcher;
  /** D-Id URL delimiter for composed keys. Default: ':' */
  dIdDelimiter: string;
  /** Persistence coordinator for write-through state saves. Absent in memory-only mode. */
  persistence?: PersistenceCoordinator | undefined;
}

/**
 * Parse a D-Id from a URL path parameter.
 *
 * Composed D-Ids join their parts with the configured delimiter (default ':').
 * Each part is percent-encoded (see {@link dIdToUrl}) so that a part value may
 * legitimately contain the delimiter, '/', or other reserved characters without
 * corrupting the part boundaries. We split on the delimiter first, then decode
 * each segment — so an ENCODED delimiter inside a value (e.g. '%3A') stays
 * within its part, while the literal delimiters that separate parts are honored.
 *
 * A raw with no unencoded delimiter is a single-key D-Id; its value is still
 * decoded to recover any reserved characters.
 */
export function parseDIdFromUrl(raw: string, delimiter: string): { type: 'single'; value: string } | { type: 'composed'; parts: string[] } {
  if (raw.includes(delimiter)) {
    return { type: 'composed', parts: raw.split(delimiter).map(decodeDIdPart) };
  }
  return { type: 'single', value: decodeDIdPart(raw) };
}

/**
 * Serialize a D-Id for URL representation.
 *
 * Each part is percent-encoded so that reserved characters — the delimiter,
 * '/', '%', and other URL-significant characters — survive a round-trip through
 * {@link parseDIdFromUrl} and the HTTP router without changing the part count or
 * breaking path routing. The delimiter itself is written literally BETWEEN
 * encoded parts, so it unambiguously separates parts.
 */
export function dIdToUrl(dId: { type: string; value?: string; parts?: readonly string[] }, delimiter: string): string {
  if (dId.type === 'single' && dId.value !== undefined) return encodeDIdPart(dId.value);
  if (dId.type === 'composed' && dId.parts) return dId.parts.map(encodeDIdPart).join(delimiter);
  return '';
}

/**
 * Percent-encode a single D-Id part for safe inclusion in a URL path segment.
 *
 * `encodeURIComponent` handles '/', '%', '?', '#', '&', space, etc. It does NOT
 * encode ':' (a sub-delimiter that is legal in a path segment), so we encode ':'
 * explicitly to prevent collision with the default composed-D-Id delimiter.
 */
export function encodeDIdPart(part: string): string {
  return encodeURIComponent(part).replace(/:/g, '%3A');
}

/** Inverse of {@link encodeDIdPart}. */
export function decodeDIdPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    // Malformed percent-encoding: return the raw segment rather than throwing,
    // so a bad client request surfaces as a not-found rather than a 500.
    return part;
  }
}
