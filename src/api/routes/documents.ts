/**
 * Document routes (T15.2)
 *
 * GET /api/v1/documents/:documentType/:dId
 * DELETE /api/v1/documents/:documentType/:dId
 * POST /api/v1/documents/:documentType/search
 * PUT /api/v1/documents/:documentType/:dId/ttl
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { parseDIdFromUrl } from '../context.js';
import { httpStatusForCode, buildErrorResponse } from '../errors.js';

export function registerDocumentRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /api/v1/documents/:documentType/:dId
  // Supports glob patterns (* and ?) in the D-Id for multi-document retrieval.
  app.get<{
    Params: { documentType: string; dId: string };
    Querystring: { path?: string; mode?: string };
  }>('/api/v1/documents/:documentType/:dId', async (request, reply) => {
    const { documentType, dId: rawDId } = request.params;
    const { path, mode } = request.query;
    const dId = parseDIdFromUrl(rawDId, ctx.dIdDelimiter);

    // Detect glob characters in the D-Id — switch to glob retrieval
    if (rawDId.includes('*') || rawDId.includes('?')) {
      const globResult = ctx.queryEngine.retrieveByGlob(documentType, dId);
      return reply.status(200).send({
        matches: globResult.documents.map((d) => d.document),
        count: globResult.documents.length,
      });
    }

    const result = ctx.queryEngine.retrieveDocument(documentType, dId, {
      ...(path ? { path } : {}),
      ...(mode ? { mode: mode as 'closed' | 'open' | 'full' } : {}),
    });

    if (!result.success) {
      const status = httpStatusForCode(result.code);
      const extras = result.reason ? { reason: result.reason } : undefined;
      return reply.status(status).send(buildErrorResponse(result.code, result.message, extras));
    }

    return reply.status(200).send(result.document);
  });

  // DELETE /api/v1/documents/:documentType/:dId
  app.delete<{
    Params: { documentType: string; dId: string };
  }>('/api/v1/documents/:documentType/:dId', async (request, reply) => {
    const { documentType, dId: rawDId } = request.params;
    const dId = parseDIdFromUrl(rawDId, ctx.dIdDelimiter);

    const result = ctx.documentManager.softDelete(documentType, dId, 'explicit');

    if (!result.success) {
      const status = result.code === 'DOCUMENT_NOT_FOUND' ? 404 : 400;
      return reply.status(status).send(buildErrorResponse(result.code!, result.message!));
    }

    return reply.status(200).send({ deleted: true });
  });

  // POST /api/v1/documents/:documentType/search
  app.post<{
    Params: { documentType: string };
    Body: { field: string; value: unknown; includeExpired?: boolean };
  }>('/api/v1/documents/:documentType/search', async (request, reply) => {
    const { documentType } = request.params;
    const { field, value, includeExpired } = request.body ?? {};

    if (!field) {
      return reply.status(400).send(buildErrorResponse('PARSE_ERROR', 'Search requires "field" and "value"'));
    }

    // Req 15.6: includeExpired defaults to true when omitted.
    const result = ctx.queryEngine.searchByValue(documentType, field, value, includeExpired ?? true);
    return reply.status(200).send({
      matches: result.matches.map((m) => m.document),
      count: result.matches.length,
    });
  });

  // PUT /api/v1/documents/:documentType/:dId/ttl
  app.put<{
    Params: { documentType: string; dId: string };
    Body: { ttl: number | 'infinite' };
  }>('/api/v1/documents/:documentType/:dId/ttl', async (request, reply) => {
    const { documentType, dId: rawDId } = request.params;
    const { ttl } = request.body ?? {};
    const dId = parseDIdFromUrl(rawDId, ctx.dIdDelimiter);

    if (ttl === undefined) {
      return reply.status(400).send(buildErrorResponse('PARSE_ERROR', 'TTL value required'));
    }

    const key = `${documentType}\x01${dId.type === 'single' ? dId.value : dId.parts.join('\x00')}`;
    const warning = ctx.ttlManager.configureTtl('document', ttl, key);

    return reply.status(200).send({
      documentType,
      dId: rawDId,
      ttl,
      ...(warning ? { warning } : {}),
    });
  });
}
