/**
 * Configuration routes (T15.5, T15.6, T15.7)
 *
 * Document_Type, channel, and instance configuration endpoints.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { httpStatusForCode, buildErrorResponse } from '../errors.js';
import { setLogLevel, setLogDestination, getLoggingState } from '../../logging/logger.js';
import type { LogLevel } from '../../config.js';
import type { LogDestination } from '../../logging/logger.js';

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ─── T15.5: Document_Type Endpoints ─────────────────────────────────────

  app.post<{
    Body: { name: string; masterSchema: string; model: string; ttl?: number | 'infinite' };
  }>('/api/v1/config/document-types', async (request, reply) => {
    const { name, masterSchema, model, ttl } = request.body ?? {};
    if (!name || !masterSchema || !model) {
      return reply.status(400).send(buildErrorResponse('PARSE_ERROR', 'name, masterSchema, and model are required'));
    }

    const result = ctx.docTypeRegistry.register({
      name,
      masterSchema,
      model: model as 'closed' | 'hybrid' | 'open',
      ...(ttl !== undefined ? { ttl } : {}),
    });

    if (!result.success) {
      return reply.status(httpStatusForCode(result.code)).send(buildErrorResponse(result.code, result.message));
    }

    // Seed the TtlManager so a creation-time Document_Type TTL actually governs
    // expiry (getEffectiveTtl reads docTypeTtls, not the registry entry). Keeps
    // the registry entry and the governing TTL in sync from creation.
    if (ttl !== undefined) {
      const warning = ctx.ttlManager.configureTtl('document_type', ttl, name);
      // Mirror any TTL-floor adjustment back onto the registry entry so the
      // GET reflects the governing value.
      if (warning) {
        ctx.docTypeRegistry.update(name, { ttl: warning.appliedTtl });
      }
    }
    return reply.status(201).send(ctx.docTypeRegistry.get(name));
  });

  app.get<{ Params: { documentType: string } }>('/api/v1/config/document-types/:documentType', async (request, reply) => {
    const config = ctx.docTypeRegistry.get(request.params.documentType);
    if (!config) {
      return reply.status(404).send(buildErrorResponse('DOCUMENT_TYPE_NOT_FOUND', 'Document_Type not found'));
    }
    return reply.status(200).send(config);
  });

  app.get('/api/v1/config/document-types', async (_request, reply) => {
    return reply.status(200).send(ctx.docTypeRegistry.list());
  });

  app.delete<{ Params: { documentType: string } }>('/api/v1/config/document-types/:documentType', async (request, reply) => {
    const result = ctx.docTypeRegistry.delete(request.params.documentType);
    if (!result.success) {
      return reply.status(httpStatusForCode(result.code!)).send(buildErrorResponse(result.code!, result.message!));
    }
    return reply.status(200).send({ deleted: true });
  });

  app.put<{
    Params: { documentType: string };
    Body: { ttl: number | 'infinite' };
  }>('/api/v1/config/document-types/:documentType/ttl', async (request, reply) => {
    const { documentType } = request.params;
    const { ttl } = request.body ?? {};
    const warning = ctx.ttlManager.configureTtl('document_type', ttl, documentType);
    // Governing value after any TTL-floor adjustment.
    const governing = warning ? warning.appliedTtl : ttl;
    // Write back to the registry so GET /config/document-types/{type} reflects
    // the governing TTL (single source of truth: the TtlManager governs, the
    // registry mirrors).
    ctx.docTypeRegistry.update(documentType, { ttl: governing });
    return reply.status(200).send({ ttl: governing, ...(warning ? { warning } : {}) });
  });

  // Effective Document_Type TTL (symmetric with GET /config/ttl/instance).
  // Returns the governing value the TtlManager actually consults for expiry.
  app.get<{ Params: { documentType: string } }>('/api/v1/config/ttl/document-type/:documentType', async (request, reply) => {
    const { documentType } = request.params;
    if (!ctx.docTypeRegistry.get(documentType)) {
      return reply.status(404).send(buildErrorResponse('DOCUMENT_TYPE_NOT_FOUND', 'Document_Type not found'));
    }
    // getEffectiveTtl with a dId that has no document-level TTL yields the
    // Document_Type TTL (or the instance TTL if none is configured for the type).
    const ttl = ctx.ttlManager.getEffectiveTtl(documentType, { type: 'single', value: '\x00__effective__' });
    return reply.status(200).send({ documentType, ttl });
  });

  // ─── T15.6: Channel Endpoints ───────────────────────────────────────────

  app.post<{
    Body: { channelId: string; documentType: string; channelSchema?: string; initialStatus?: 'active' | 'inactive' };
  }>('/api/v1/config/channels', async (request, reply) => {
    const { channelId, documentType, channelSchema, initialStatus } = request.body ?? {};
    if (!channelId || !documentType) {
      return reply.status(400).send(buildErrorResponse('PARSE_ERROR', 'channelId and documentType are required'));
    }

    const result = ctx.channelResolver.register({
      channelId,
      documentType,
      ...(channelSchema ? { channelSchema } : {}),
      ...(initialStatus ? { initialStatus } : {}),
    });
    if (!result.success) {
      return reply.status(httpStatusForCode(result.code)).send(buildErrorResponse(result.code, result.message));
    }
    return reply.status(201).send(result.config);
  });

  app.put<{
    Params: { channelId: string };
    Body: { channelSchema?: string | null };
  }>('/api/v1/config/channels/:channelId', async (request, reply) => {
    const cs = request.body?.channelSchema;
    const result = ctx.channelResolver.update(request.params.channelId, {
      ...(cs !== undefined ? { channelSchema: cs } : {}),
    });
    if (!result.success) {
      return reply.status(httpStatusForCode(result.code)).send(buildErrorResponse(result.code, result.message));
    }
    return reply.status(200).send(result.config);
  });

  app.delete<{ Params: { channelId: string } }>('/api/v1/config/channels/:channelId', async (request, reply) => {
    const result = ctx.channelResolver.delete(request.params.channelId);
    if (!result.success) {
      return reply.status(httpStatusForCode(result.code!)).send(buildErrorResponse(result.code!, result.message!));
    }
    return reply.status(200).send({ deleted: true });
  });

  app.get('/api/v1/config/channels', async (request, reply) => {
    const docType = (request.query as Record<string, string>)['documentType'];
    return reply.status(200).send(ctx.channelResolver.list(docType));
  });

  app.post<{ Params: { channelId: string } }>('/api/v1/config/channels/:channelId/activate', async (request, reply) => {
    const result = ctx.channelResolver.activate(request.params.channelId);
    if (!result.success) {
      return reply.status(httpStatusForCode(result.code!)).send(buildErrorResponse(result.code!, result.message!));
    }
    return reply.status(200).send({ channelId: request.params.channelId, status: 'active' });
  });

  app.post<{ Params: { channelId: string } }>('/api/v1/config/channels/:channelId/deactivate', async (request, reply) => {
    const result = ctx.channelResolver.deactivate(request.params.channelId);
    if (!result.success) {
      return reply.status(httpStatusForCode(result.code!)).send(buildErrorResponse(result.code!, result.message!));
    }
    return reply.status(200).send({ channelId: request.params.channelId, status: 'inactive' });
  });

  // Enrichment bindings
  app.put<{
    Params: { channelId: string };
    Body: { bindings: { fieldPath: string; staticValue: unknown }[] };
  }>('/api/v1/config/channels/:channelId/enrichment', async (request, reply) => {
    const { bindings } = request.body ?? {};
    if (!bindings) {
      return reply.status(400).send(buildErrorResponse('PARSE_ERROR', 'bindings array required'));
    }
    const result = ctx.enrichmentEngine.registerBindings(request.params.channelId, bindings);
    if (!result.success) {
      return reply.status(httpStatusForCode(result.code)).send(buildErrorResponse(result.code, result.message));
    }
    return reply.status(200).send({ registered: true, dIdClassification: result.dIdClassification });
  });

  app.get<{ Params: { channelId: string } }>('/api/v1/config/channels/:channelId/enrichment', async (request, reply) => {
    const bindings = ctx.enrichmentEngine.getBindings(request.params.channelId);
    return reply.status(200).send(bindings);
  });

  app.delete<{ Params: { channelId: string } }>('/api/v1/config/channels/:channelId/enrichment', async (request, reply) => {
    ctx.enrichmentEngine.deleteBindings(request.params.channelId);
    return reply.status(200).send({ deleted: true });
  });

  // ─── T15.7: Instance Configuration Endpoints ───────────────────────────

  app.get('/api/v1/config/ttl/instance', async (_request, reply) => {
    return reply.status(200).send({ ttl: ctx.ttlManager.getInstanceTtl() });
  });

  app.put<{ Body: { ttl: number | 'infinite' } }>('/api/v1/config/ttl/instance', async (request, reply) => {
    const { ttl } = request.body ?? {};
    const warning = ctx.ttlManager.configureTtl('instance', ttl);
    return reply.status(200).send({ ttl: ctx.ttlManager.getInstanceTtl(), ...(warning ? { warning } : {}) });
  });

  app.put<{ Body: { interval: number } }>('/api/v1/config/ttl/sweep-interval', async (request, reply) => {
    const { interval } = request.body ?? {};
    ctx.ttlManager.setSweepInterval(interval);
    return reply.status(200).send({ sweepInterval: ctx.ttlManager.getSweepInterval() });
  });

  app.get('/api/v1/config/storage-strategy', async (_request, reply) => {
    return reply.status(200).send({ mode: ctx.storageManager.getStrategy() });
  });

  app.put<{ Body: { mode: string } }>('/api/v1/config/storage-strategy', async (request, reply) => {
    const { mode } = request.body ?? {};
    ctx.storageManager.setStrategy(mode as 'auto' | 'memory' | 'disk' | 'hybrid');
    return reply.status(200).send({ mode: ctx.storageManager.getStrategy() });
  });

  app.post('/api/v1/config/storage/drain', async (_request, reply) => {
    const count = ctx.storageManager.drain();
    return reply.status(200).send({ drained: true, documentsWritten: count, mode: ctx.storageManager.getStrategy() });
  });

  app.get('/api/v1/config/quarantine-policy', async (_request, reply) => {
    return reply.status(200).send({ policy: ctx.quarantineStore.getPolicy() });
  });

  app.put<{ Body: { policy: string } }>('/api/v1/config/quarantine-policy', async (request, reply) => {
    const { policy } = request.body ?? {};
    ctx.quarantineStore.setPolicy(policy as 'off' | 'data-errors-only' | 'all-rejections');
    return reply.status(200).send({ policy: ctx.quarantineStore.getPolicy() });
  });

  app.get('/api/v1/config/enrichment-policies', async (_request, reply) => {
    return reply.status(200).send(ctx.enrichmentEngine.getPolicies());
  });

  app.put<{ Body: { precedence?: string; conflictResolution?: string } }>('/api/v1/config/enrichment-policies', async (request, reply) => {
    const { precedence, conflictResolution } = request.body ?? {};
    ctx.enrichmentEngine.setPolicies({
      ...(precedence ? { precedence: precedence as 'environment-over-content' | 'content-over-environment' } : {}),
      ...(conflictResolution ? { conflictResolution: conflictResolution as 'accept-and-warn' | 'discard-and-error' } : {}),
    });
    return reply.status(200).send(ctx.enrichmentEngine.getPolicies());
  });

  app.get('/api/v1/config/log-level', async (_request, reply) => {
    return reply.status(200).send(getLoggingState());
  });

  app.put<{ Body: { level: string } }>('/api/v1/config/log-level', async (request, reply) => {
    const { level } = request.body ?? {};
    setLogLevel(level as LogLevel);
    return reply.status(200).send(getLoggingState());
  });

  app.get('/api/v1/config/log-destination', async (_request, reply) => {
    return reply.status(200).send(getLoggingState());
  });

  app.put<{ Body: { destination: string; filePath?: string } }>('/api/v1/config/log-destination', async (request, reply) => {
    const { destination, filePath } = request.body ?? {};
    if (!destination) {
      return reply.status(400).send(buildErrorResponse('PARSE_ERROR', 'destination is required'));
    }
    const valid: LogDestination[] = ['stdout', 'file', 'none'];
    if (!valid.includes(destination as LogDestination)) {
      return reply.status(400).send(buildErrorResponse('PARSE_ERROR', `destination must be one of: ${valid.join(', ')}`));
    }
    if (destination === 'file' && !filePath) {
      return reply.status(400).send(buildErrorResponse('PARSE_ERROR', 'filePath is required when destination is "file"'));
    }
    setLogDestination(destination as LogDestination, filePath);
    return reply.status(200).send(getLoggingState());
  });
}
