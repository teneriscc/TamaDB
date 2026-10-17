/**
 * Subscription routes (T15.3)
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { parseDIdFromUrl } from '../context.js';
import { buildErrorResponse } from '../errors.js';

export function registerSubscriptionRoutes(app: FastifyInstance, ctx: AppContext): void {
  // POST /api/v1/subscriptions
  app.post<{
    Body: { scope: string; documentType: string; dId?: string; callbackUrl: string; path?: string; options?: Record<string, unknown> };
  }>('/api/v1/subscriptions', async (request, reply) => {
    const { scope, documentType, dId: rawDId, callbackUrl, path, options } = request.body ?? {};

    if (!scope || !documentType || !callbackUrl) {
      return reply.status(400).send(buildErrorResponse('PARSE_ERROR', 'scope, documentType, and callbackUrl are required'));
    }

    const dId = rawDId ? parseDIdFromUrl(rawDId, ctx.dIdDelimiter) : undefined;
    const sub = ctx.subscriptionManager.subscribe({
      scope: scope as 'document_type' | 'document_id',
      documentType,
      ...(dId ? { dId } : {}),
      ...(path ? { path } : {}),
      callbackUrl,
      ...(options ? { options: options as Record<string, unknown> } : {}),
    });

    return reply.status(201).send(sub);
  });

  // DELETE /api/v1/subscriptions/:subscriptionId
  app.delete<{ Params: { subscriptionId: string } }>('/api/v1/subscriptions/:subscriptionId', async (request, reply) => {
    const { subscriptionId } = request.params;
    const deleted = ctx.subscriptionManager.unsubscribe(subscriptionId);

    if (!deleted) {
      return reply.status(404).send(buildErrorResponse('SUBSCRIPTION_NOT_FOUND', `Subscription '${subscriptionId}' not found`));
    }

    return reply.status(200).send({ cancelled: true });
  });

  // GET /api/v1/documents/:documentType/:dId/subscriptions
  app.get<{ Params: { documentType: string; dId: string } }>('/api/v1/documents/:documentType/:dId/subscriptions', async (request, reply) => {
    const { documentType, dId: rawDId } = request.params;
    const dId = parseDIdFromUrl(rawDId, ctx.dIdDelimiter);
    const subs = ctx.subscriptionManager.listByDocumentId(documentType, dId);
    return reply.status(200).send(subs);
  });

  // GET /api/v1/document-types/:documentType/subscriptions
  app.get<{ Params: { documentType: string } }>('/api/v1/document-types/:documentType/subscriptions', async (request, reply) => {
    const { documentType } = request.params;
    const subs = ctx.subscriptionManager.listByDocumentType(documentType);
    return reply.status(200).send(subs);
  });
}
