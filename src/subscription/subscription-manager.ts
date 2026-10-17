/**
 * Subscription Manager implementation (T12.1–T12.10)
 *
 * Manages subscription lifecycle, event matching, payload formatting,
 * and webhook job creation (snapshot-at-enqueue).
 *
 * Design reference: design.md § Subscription Manager
 * Validates: Requirements 16, 35, 38, 39, 40
 */

import type { DocumentIdentifier } from '../storage/types.js';
import { storageKey } from '../storage/types.js';
import type {
  SubscribeRequest,
  Subscription,
  SubscriptionManager,
  SubscriptionOptions,
  WebhookJob,
} from './types.js';

const DEFAULT_OPTIONS: SubscriptionOptions = {
  retrievalMode: 'full',
  schemaAdoptionMode: 'pinned',
  payloadFormat: 'envelope',
  includeMetadata: false,
  deliveryMode: 'fire-and-forget',
};

export class SubscriptionManagerImpl implements SubscriptionManager {
  /** All subscriptions by ID. */
  private readonly subscriptions = new Map<string, Subscription>();

  /** Index: documentType → subscription IDs (Document_Type-level subs). */
  private readonly byDocType = new Map<string, Set<string>>();

  /** Index: storageKey(docType, dId) → subscription IDs (D-Id-level subs). */
  private readonly byDocId = new Map<string, Set<string>>();

  /** Counter for generating unique subscription IDs. */
  private idCounter = 0;

  // ─── T12.1, T12.2: Subscription Creation ──────────────────────────────

  subscribe(request: SubscribeRequest): Subscription {
    const id = this.generateId();
    const options: SubscriptionOptions = {
      ...DEFAULT_OPTIONS,
      ...request.options,
    };

    const subscription: Subscription = {
      id,
      scope: request.scope,
      documentType: request.documentType,
      ...(request.dId !== undefined ? { dId: request.dId } : {}),
      ...(request.path !== undefined ? { path: request.path } : {}),
      callbackUrl: request.callbackUrl,
      options,
      createdAt: new Date().toISOString(),
      active: true,
    };

    this.subscriptions.set(id, subscription);

    // Index by scope
    if (request.scope === 'document_type') {
      let set = this.byDocType.get(request.documentType);
      if (!set) {
        set = new Set();
        this.byDocType.set(request.documentType, set);
      }
      set.add(id);
    } else if (request.scope === 'document_id' && request.dId) {
      const key = storageKey(request.documentType, request.dId);
      let set = this.byDocId.get(key);
      if (!set) {
        set = new Set();
        this.byDocId.set(key, set);
      }
      set.add(id);
    }

    return subscription;
  }

  // ─── T12.3: Cancellation ───────────────────────────────────────────────

  unsubscribe(subscriptionId: string): boolean {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return false;

    sub.active = false;
    this.removeFromIndices(sub);
    this.subscriptions.delete(subscriptionId);
    return true;
  }

  // ─── T12.4: Listing ────────────────────────────────────────────────────

  listByDocumentType(documentType: string): Subscription[] {
    const ids = this.byDocType.get(documentType);
    if (!ids) return [];
    return [...ids].map((id) => this.subscriptions.get(id)!).filter((s) => s.active);
  }

  listByDocumentId(documentType: string, dId: DocumentIdentifier): Subscription[] {
    const key = storageKey(documentType, dId);
    const ids = this.byDocId.get(key);
    if (!ids) return [];
    return [...ids].map((id) => this.subscriptions.get(id)!).filter((s) => s.active);
  }

  // ─── T12.5: Event Matching ─────────────────────────────────────────────

  findMatching(documentType: string, dId: DocumentIdentifier): Subscription[] {
    const matched: Subscription[] = [];

    // Document_Type-level subscriptions
    const typeIds = this.byDocType.get(documentType);
    if (typeIds) {
      for (const id of typeIds) {
        const sub = this.subscriptions.get(id);
        if (sub?.active) matched.push(sub);
      }
    }

    // D-Id-level subscriptions
    const key = storageKey(documentType, dId);
    const docIds = this.byDocId.get(key);
    if (docIds) {
      for (const id of docIds) {
        const sub = this.subscriptions.get(id);
        if (sub?.active) matched.push(sub);
      }
    }

    return matched;
  }

  // ─── T12.6: Payload Formatting ─────────────────────────────────────────

  formatPayload(
    document: Record<string, unknown>,
    subscription: Subscription,
    dId: DocumentIdentifier,
    documentType: string,
  ): unknown {
    const { options } = subscription;

    // Apply Retrieval_Schema filtering
    let filtered: Record<string, unknown>;
    if (options.retrievalMode === 'closed' && options.retrievalSchema) {
      const schemaFields = new Set(Object.keys(
        (options.retrievalSchema['properties'] ?? {}) as Record<string, unknown>,
      ));
      filtered = {};
      for (const key of schemaFields) {
        if (key in document) {
          filtered[key] = document[key];
        }
      }
    } else {
      filtered = { ...document };
    }

    // T13.7 / raw format: document only
    if (options.payloadFormat === 'raw') {
      return filtered;
    }

    // T13.6 / envelope format
    const envelope: Record<string, unknown> = {
      subscriptionId: subscription.id,
      dId: dId.type === 'single' ? dId.value : dId.parts,
      documentType,
      document: filtered,
      timestamp: new Date().toISOString(),
    };

    if (subscription.path) {
      envelope['path'] = subscription.path;
    }

    return envelope;
  }

  // ─── T12.7: Snapshot-at-Enqueue ────────────────────────────────────────

  createWebhookJobs(
    document: Record<string, unknown>,
    documentType: string,
    dId: DocumentIdentifier,
  ): WebhookJob[] {
    const matching = this.findMatching(documentType, dId);
    const jobs: WebhookJob[] = [];

    for (const sub of matching) {
      const payload = this.formatPayload(document, sub, dId, documentType);
      jobs.push({
        subscriptionId: sub.id,
        subscription: sub,
        payload,
        enqueuedAt: new Date().toISOString(),
        documentType,
        dId,
      });
    }

    return jobs;
  }

  // ─── T12.8: Auto-Cancel on Explicit Soft-Delete ────────────────────────

  cancelAllForDocument(documentType: string, dId: DocumentIdentifier): number {
    const key = storageKey(documentType, dId);
    const ids = this.byDocId.get(key);
    if (!ids) return 0;

    let cancelled = 0;
    for (const id of [...ids]) {
      const sub = this.subscriptions.get(id);
      if (sub?.active) {
        sub.active = false;
        this.subscriptions.delete(id);
        cancelled++;
      }
    }

    this.byDocId.delete(key);
    return cancelled;
  }

  // ─── Get by ID ─────────────────────────────────────────────────────────

  get(subscriptionId: string): Subscription | undefined {
    return this.subscriptions.get(subscriptionId);
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private generateId(): string {
    this.idCounter++;
    return `sub-${Date.now().toString(36)}-${this.idCounter.toString(36).padStart(4, '0')}`;
  }

  private removeFromIndices(sub: Subscription): void {
    if (sub.scope === 'document_type') {
      const set = this.byDocType.get(sub.documentType);
      if (set) {
        set.delete(sub.id);
        if (set.size === 0) this.byDocType.delete(sub.documentType);
      }
    } else if (sub.scope === 'document_id' && sub.dId) {
      const key = storageKey(sub.documentType, sub.dId);
      const set = this.byDocId.get(key);
      if (set) {
        set.delete(sub.id);
        if (set.size === 0) this.byDocId.delete(key);
      }
    }
  }

  // ─── Persistence: Snapshot & Restore ────────────────────────────────────

  snapshot(): { subscriptions: Subscription[]; idCounter: number } {
    return {
      subscriptions: [...this.subscriptions.values()],
      idCounter: this.idCounter,
    };
  }

  restoreState(state: { subscriptions: Subscription[]; idCounter: number }): void {
    this.subscriptions.clear();
    this.byDocType.clear();
    this.byDocId.clear();
    this.idCounter = state.idCounter;

    for (const sub of state.subscriptions) {
      this.subscriptions.set(sub.id, sub);
      this.indexSubscription(sub);
    }
  }

  private indexSubscription(sub: Subscription): void {
    if (sub.scope === 'document_type') {
      if (!this.byDocType.has(sub.documentType)) {
        this.byDocType.set(sub.documentType, new Set());
      }
      this.byDocType.get(sub.documentType)!.add(sub.id);
    } else if (sub.scope === 'document_id' && sub.dId) {
      const key = storageKey(sub.documentType, sub.dId);
      if (!this.byDocId.has(key)) {
        this.byDocId.set(key, new Set());
      }
      this.byDocId.get(key)!.add(sub.id);
    }
  }
}
