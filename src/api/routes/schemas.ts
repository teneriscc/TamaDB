/**
 * Schema repository routes (T15.4)
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { httpStatusForCode, buildErrorResponse } from '../errors.js';

export function registerSchemaRoutes(app: FastifyInstance, ctx: AppContext): void {
  // POST /api/v1/schemas
  app.post<{
    Body: { ref: string; schema: Record<string, unknown>; dIdDefinition?: { type: string; fields: string[] } };
  }>('/api/v1/schemas', async (request, reply) => {
    const { ref, schema, dIdDefinition } = request.body ?? {};

    if (!ref || !schema) {
      return reply.status(400).send(buildErrorResponse('PARSE_ERROR', 'ref and schema are required'));
    }

    const result = ctx.schemaManager.register({
      ref,
      schema,
      ...(dIdDefinition ? { dIdDefinition: dIdDefinition as { type: 'single' | 'composed'; fields: readonly string[] } } : {}),
    });

    if (!result.success) {
      return reply.status(httpStatusForCode(result.code)).send(buildErrorResponse(result.code, result.message));
    }

    return reply.status(201).send({ ref: result.ref, version: result.version });
  });

  // GET /api/v1/schemas — list all registered schemas.
  // Symmetric with GET /api/v1/config/document-types; returns the full entry
  // array (ref, schema, version, versions, lifecycle, dIdDefinition?, timestamps).
  app.get('/api/v1/schemas', async (_request, reply) => {
    return reply.status(200).send(ctx.schemaManager.list());
  });

  // GET /api/v1/schemas/:schemaRef
  app.get<{ Params: { schemaRef: string } }>('/api/v1/schemas/:schemaRef', async (request, reply) => {
    const entry = ctx.schemaManager.get(request.params.schemaRef);
    if (!entry) {
      return reply.status(404).send(buildErrorResponse('SCHEMA_NOT_FOUND', `Schema '${request.params.schemaRef}' not found`));
    }
    return reply.status(200).send(entry);
  });

  // PUT /api/v1/schemas/:schemaRef
  app.put<{
    Params: { schemaRef: string };
    Body: { schema: Record<string, unknown> };
  }>('/api/v1/schemas/:schemaRef', async (request, reply) => {
    const { schema } = request.body ?? {};
    if (!schema) {
      return reply.status(400).send(buildErrorResponse('PARSE_ERROR', 'schema is required'));
    }

    const result = ctx.schemaManager.update(request.params.schemaRef, schema);
    if (!result.success) {
      return reply.status(httpStatusForCode(result.code)).send(buildErrorResponse(result.code, result.message));
    }

    return reply.status(200).send({ ref: result.ref, version: result.version });
  });

  // POST /api/v1/schemas/:schemaRef/decommission
  app.post<{ Params: { schemaRef: string } }>('/api/v1/schemas/:schemaRef/decommission', async (request, reply) => {
    const result = ctx.schemaManager.decommission(request.params.schemaRef);
    if (!result.success) {
      return reply.status(httpStatusForCode(result.code!)).send(buildErrorResponse(result.code!, result.message!));
    }
    return reply.status(200).send({ decommissioned: true });
  });

  // POST /api/v1/schemas/:schemaRef/reactivate
  app.post<{ Params: { schemaRef: string } }>('/api/v1/schemas/:schemaRef/reactivate', async (request, reply) => {
    const result = ctx.schemaManager.reactivate(request.params.schemaRef);
    if (!result.success) {
      return reply.status(httpStatusForCode(result.code!)).send(buildErrorResponse(result.code!, result.message!));
    }
    return reply.status(200).send({ reactivated: true });
  });

  // GET /api/v1/schemas/:schemaRef/versions
  app.get<{ Params: { schemaRef: string } }>('/api/v1/schemas/:schemaRef/versions', async (request, reply) => {
    const entry = ctx.schemaManager.get(request.params.schemaRef);
    if (!entry) {
      return reply.status(404).send(buildErrorResponse('SCHEMA_NOT_FOUND', `Schema '${request.params.schemaRef}' not found`));
    }
    return reply.status(200).send(entry.versions);
  });
}
