/**
 * Subscription Manager types (T12.1–T12.10)
 *
 * Defines subscriptions, delivery modes, payload formats, and the
 * SubscriptionManager interface.
 *
 * Design reference: design.md § Subscription Manager
 * Validates: Requirements 16, 35, 38, 39, 40
 */

import type { DocumentIdentifier } from '../storage/types.js';

// ─── Subscription Scope ─────────────────────────────────────────────────────

export type SubscriptionScope = 'document_type' | 'document_id';

// ─── Delivery & Format ──────────────────────────────────────────────────────

export type DeliveryMode = 'fire-and-forget' | 'retry';
export type PayloadFormat = 'envelope' | 'raw';
export type SchemaAdoptionMode = 'pinned' | 'propagate';
export type RetrievalMode = 'closed' | 'open' | 'full';

// ─── Subscription Options ───────────────────────────────────────────────────

export interface SubscriptionOptions {
  readonly retrievalSchema?: Record<string, unknown>;
  readonly retrievalMode: RetrievalMode;
  readonly schemaAdoptionMode: SchemaAdoptionMode;
  readonly payloadFormat: PayloadFormat;
  readonly includeMetadata: boolean;
  readonly deliveryMode: DeliveryMode;
}

// ─── Subscription ───────────────────────────────────────────────────────────

export interface Subscription {
  readonly id: string;
  readonly scope: SubscriptionScope;
  readonly documentType: string;
  readonly dId?: DocumentIdentifier;
  readonly path?: string;
  readonly callbackUrl: string;
  readonly options: SubscriptionOptions;
  readonly createdAt: string;
  active: boolean;
}

// ─── Subscription Request ───────────────────────────────────────────────────

export interface SubscribeRequest {
  readonly scope: SubscriptionScope;
  readonly documentType: string;
  readonly dId?: DocumentIdentifier;
  readonly path?: string;
  readonly callbackUrl: string;
  readonly options?: Partial<SubscriptionOptions>;
}

// ─── Webhook Job (snapshot-at-enqueue) ──────────────────────────────────────

export interface WebhookJob {
  readonly subscriptionId: string;
  readonly subscription: Subscription;
  readonly payload: unknown;
  readonly enqueuedAt: string;
  readonly documentType: string;
  readonly dId: DocumentIdentifier;
}

// ─── Subscription Manager Interface ─────────────────────────────────────────

export interface SubscriptionManager {
  /**
   * Create a subscription (T12.1, T12.2).
   */
  subscribe(request: SubscribeRequest): Subscription;

  /**
   * Cancel a subscription (T12.3).
   */
  unsubscribe(subscriptionId: string): boolean;

  /**
   * List subscriptions by Document_Type or D-Id (T12.4).
   */
  listByDocumentType(documentType: string): Subscription[];
  listByDocumentId(documentType: string, dId: DocumentIdentifier): Subscription[];

  /**
   * Find all matching subscriptions for a store event (T12.5).
   * Returns both Document_Type-level and D-Id-level matches.
   */
  findMatching(documentType: string, dId: DocumentIdentifier): Subscription[];

  /**
   * Format a document payload per subscriber's options (T12.6).
   */
  formatPayload(
    document: Record<string, unknown>,
    subscription: Subscription,
    dId: DocumentIdentifier,
    documentType: string,
  ): unknown;

  /**
   * Create webhook jobs for all matching subscriptions (T12.7).
   * Snapshot-at-enqueue: payload captured at this moment.
   */
  createWebhookJobs(
    document: Record<string, unknown>,
    documentType: string,
    dId: DocumentIdentifier,
  ): WebhookJob[];

  /**
   * Auto-cancel all subscriptions on a document (T12.8).
   * Called on explicit soft-delete only.
   */
  cancelAllForDocument(documentType: string, dId: DocumentIdentifier): number;

  /**
   * Get a subscription by ID.
   */
  get(subscriptionId: string): Subscription | undefined;
}
