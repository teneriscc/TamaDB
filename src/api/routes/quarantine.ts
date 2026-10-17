/**
 * Quarantine routes (T15.8)
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { buildErrorResponse } from '../errors.js';

export function registerQuarantineRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /api/v1/quarantine/:quarantineRef
  app.get<{ Params: { quarantineRef: string } }>('/api/v1/quarantine/:quarantineRef', async (request, reply) => {
    const entry = ctx.quarantineStore.get(request.params.quarantineRef);
    if (!entry) {
      return reply.status(404).send(buildErrorResponse('QUARANTINE_NOT_FOUND', 'Quarantine entry not found or evicted'));
    }
    return reply.status(200).send(entry);
  });

  // GET /api/v1/quarantine
  app.get<{
    Querystring: { rejectionType?: string; sourceIdentifier?: string; limit?: string; offset?: string };
  }>('/api/v1/quarantine', async (request, reply) => {
    const { rejectionType, sourceIdentifier, limit, offset } = request.query;
    const entries = ctx.quarantineStore.list({
      ...(rejectionType ? { rejectionType: rejectionType as 'parse-error' | 'validation-failure' } : {}),
      ...(sourceIdentifier ? { sourceIdentifier } : {}),
      ...(limit ? { limit: Number.parseInt(limit, 10) } : {}),
      ...(offset ? { offset: Number.parseInt(offset, 10) } : {}),
    });
    return reply.status(200).send({ entries, count: entries.length });
  });
}
