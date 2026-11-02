/**
 * API module — public API (Component 15)
 *
 * Registers all route plugins on a Fastify instance.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerSubscriptionRoutes } from './routes/subscriptions.js';
import { registerSchemaRoutes } from './routes/schemas.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerQuarantineRoutes } from './routes/quarantine.js';

/**
 * Register all TamaDB API routes on the given Fastify instance.
 */
export function registerAllRoutes(app: FastifyInstance, ctx: AppContext): void {
  // NOTE: the ingest routes use a raw-string body parser, but that parser is
  // scoped to the ingest plugin only (see registerIngestRoutes), so it does not
  // affect the JSON parsing of the other routes registered below.
  registerIngestRoutes(app, ctx);
  registerDocumentRoutes(app, ctx);
  registerSubscriptionRoutes(app, ctx);
  registerSchemaRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerQuarantineRoutes(app, ctx);
}

export type { AppContext } from './context.js';
export { parseDIdFromUrl, dIdToUrl, encodeDIdPart, decodeDIdPart } from './context.js';
export { httpStatusForCode, buildErrorResponse } from './errors.js';
export type { ErrorResponse, ErrorContext } from './errors.js';
