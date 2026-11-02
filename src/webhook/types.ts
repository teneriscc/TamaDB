/**
 * Webhook Dispatcher types (T13.1–T13.10)
 *
 * Defines the webhook queue, delivery modes, expiry enforcement,
 * and the WebhookDispatcher interface.
 *
 * Design reference: design.md § Webhook Dispatcher
 * Validates: Requirements 35, 37.12c-d
 */

import type { DocumentIdentifier } from '../storage/types.js';

// ─── Expiry Enforcement ─────────────────────────────────────────────────────

export type ExpiryEnforcementMode = 'hard-cutoff' | 'enqueue-cutoff';

// ─── Webhook Job ────────────────────────────────────────────────────────────

export interface WebhookJob {
  readonly jobId: string;
  readonly subscriptionId: string;
  readonly dId: DocumentIdentifier;
  readonly documentType: string;
  /** Snapshot payload captured at enqueue time. */
  readonly payload: unknown;
  readonly callbackUrl: string;
  readonly enqueuedAt: string;
  readonly expireAt?: string;
  readonly expiryMode?: ExpiryEnforcementMode;
  readonly deliveryMode: 'fire-and-forget' | 'retry';
  attempt: number;
  readonly maxAttempts: number;
  /** Scheduled time for next attempt (used for backoff). */
  nextAttemptAt?: string;
  /** Last error message (for logging on exhaustion). */
  lastError?: string;
  status: 'pending' | 'delivered' | 'suppressed' | 'dropped';
}

// ─── Delivery Result ────────────────────────────────────────────────────────

export interface DeliverySuccess {
  readonly success: true;
  readonly statusCode: number;
}

export interface DeliveryFailure {
  readonly success: false;
  readonly error: string;
  readonly statusCode?: number;
}

export type DeliveryResult = DeliverySuccess | DeliveryFailure;

// ─── Delivery Function (injectable for testing) ─────────────────────────────

/**
 * Function that performs the actual HTTP POST to a callback URL.
 * Injected to allow testing without real network calls.
 */
export type DeliveryFn = (callbackUrl: string, payload: unknown) => Promise<DeliveryResult>;

// ─── Webhook Dispatcher Interface ───────────────────────────────────────────

export interface WebhookDispatcher {
  /**
   * Enqueue a webhook job (T13.1, T13.7 snapshot already captured).
   */
  enqueue(job: Omit<WebhookJob, 'jobId' | 'attempt' | 'status' | 'maxAttempts'> & { maxAttempts?: number }): WebhookJob;

  /**
   * Process the next pending job in the queue (T13.2, T13.3).
   * Returns the delivery result.
   */
  processNext(now?: string): Promise<{ job: WebhookJob; result: DeliveryResult } | undefined>;

  /**
   * Get the number of pending jobs.
   */
  pendingCount(): number;

  /**
   * Get all jobs (for inspection).
   */
  listJobs(): WebhookJob[];

  /**
   * Set the delivery function (for testing/integration).
   */
  setDeliveryFn(fn: DeliveryFn): void;

  /**
   * Set the default max retry attempts.
   */
  setMaxRetries(n: number): void;
}
