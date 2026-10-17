/**
 * Webhook Dispatcher implementation (T13.1–T13.10)
 *
 * Manages the webhook delivery queue with snapshot-at-enqueue semantics,
 * fire-and-forget and retry delivery modes, Expire-at-Point-in-Time
 * enforcement, and exponential backoff.
 *
 * Design reference: design.md § Webhook Dispatcher
 * Validates: Requirements 35, 37.12c-d
 */

import type {
  DeliveryFn,
  DeliveryResult,
  WebhookDispatcher,
  WebhookJob,
} from './types.js';

/** Exponential backoff schedule in milliseconds: 1s, 2s, 4s, 8s, 16s. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

export class WebhookDispatcherImpl implements WebhookDispatcher {
  /** FIFO queue of pending jobs. */
  private readonly queue: WebhookJob[] = [];

  /** All jobs (including completed) for inspection. */
  private readonly allJobs: WebhookJob[] = [];

  /** Counter for unique job IDs. */
  private jobCounter = 0;

  /** Default max retry attempts. */
  private maxRetries = 5;

  /** Delivery function (injectable). */
  private deliveryFn: DeliveryFn = defaultDeliveryFn;

  // ─── T13.1: Enqueue ────────────────────────────────────────────────────

  enqueue(
    partial: Omit<WebhookJob, 'jobId' | 'attempt' | 'status' | 'maxAttempts'> & { maxAttempts?: number },
  ): WebhookJob {
    const job: WebhookJob = {
      ...partial,
      jobId: this.generateJobId(),
      attempt: 0,
      maxAttempts: partial.maxAttempts ?? (partial.deliveryMode === 'retry' ? this.maxRetries : 1),
      status: 'pending',
    };

    this.queue.push(job);
    this.allJobs.push(job);
    return job;
  }

  // ─── T13.2, T13.3, T13.4: Process Next Job ────────────────────────────

  async processNext(now?: string): Promise<{ job: WebhookJob; result: DeliveryResult } | undefined> {
    const job = this.findNextReady(now);
    if (!job) return undefined;

    // T13.4: Expire-at-Point-in-Time enforcement (hard-cutoff)
    if (this.shouldSuppress(job, now)) {
      job.status = 'suppressed';
      this.removeFromQueue(job);
      return { job, result: { success: false, error: 'Suppressed by hard-cutoff expiry' } };
    }

    // Attempt delivery
    job.attempt++;
    const result = await this.deliveryFn(job.callbackUrl, job.payload);

    if (result.success) {
      job.status = 'delivered';
      this.removeFromQueue(job);
      return { job, result };
    }

    // Delivery failed
    job.lastError = result.error;

    if (job.deliveryMode === 'fire-and-forget') {
      // T13.2: Single attempt, drop on failure
      job.status = 'dropped';
      this.removeFromQueue(job);
      return { job, result };
    }

    // T13.3: Retry mode — check if attempts exhausted
    if (job.attempt >= job.maxAttempts) {
      // T13.9: Retry exhaustion — drop permanently, log warning
      job.status = 'dropped';
      this.removeFromQueue(job);
      return { job, result };
    }

    // Schedule retry with exponential backoff
    const backoffIndex = Math.min(job.attempt - 1, BACKOFF_MS.length - 1);
    const backoffMs = BACKOFF_MS[backoffIndex]!;
    const currentTime = now ? new Date(now).getTime() : Date.now();
    job.nextAttemptAt = new Date(currentTime + backoffMs).toISOString();

    return { job, result };
  }

  // ─── Queue Management ──────────────────────────────────────────────────

  pendingCount(): number {
    return this.queue.filter((j) => j.status === 'pending').length;
  }

  listJobs(): WebhookJob[] {
    return [...this.allJobs];
  }

  setDeliveryFn(fn: DeliveryFn): void {
    this.deliveryFn = fn;
  }

  setMaxRetries(n: number): void {
    this.maxRetries = n > 0 ? n : 1;
  }

  // ─── Private: Suppression Check (T13.4) ────────────────────────────────

  /**
   * T13.4: hard-cutoff mode checks before every attempt.
   * enqueue-cutoff: no check (already-enqueued jobs complete).
   * T13.10: TTL never suppresses (only Expire-at-Point-in-Time does).
   */
  private shouldSuppress(job: WebhookJob, now?: string): boolean {
    if (!job.expireAt) return false;
    if (job.expiryMode !== 'hard-cutoff') return false;

    const currentTime = now ?? new Date().toISOString();
    return currentTime >= job.expireAt;
  }

  // ─── Private: Find Next Ready Job ──────────────────────────────────────

  private findNextReady(now?: string): WebhookJob | undefined {
    const currentTime = now ?? new Date().toISOString();

    for (const job of this.queue) {
      if (job.status !== 'pending') continue;

      // Check if job is ready (no backoff delay or delay has passed)
      if (job.nextAttemptAt && job.nextAttemptAt > currentTime) continue;

      return job;
    }

    return undefined;
  }

  private removeFromQueue(job: WebhookJob): void {
    const idx = this.queue.indexOf(job);
    if (idx !== -1) this.queue.splice(idx, 1);
  }

  private generateJobId(): string {
    this.jobCounter++;
    return `wh-${Date.now().toString(36)}-${this.jobCounter.toString(36).padStart(4, '0')}`;
  }
}

// ─── Default Delivery Function ───────────────────────────────────────────────

/**
 * Default delivery function — performs actual HTTP POST.
 * In production this would use fetch/undici. For now, a stub that
 * always fails (tests inject their own delivery function).
 */
async function defaultDeliveryFn(_callbackUrl: string, _payload: unknown): Promise<DeliveryResult> {
  return { success: false, error: 'No delivery function configured' };
}
