/**
 * Subscription module — public API (Component 12)
 *
 * Exports the Subscription Manager implementation and associated types.
 */

export { SubscriptionManagerImpl } from './subscription-manager.js';
export type {
  DeliveryMode,
  PayloadFormat,
  RetrievalMode,
  SchemaAdoptionMode,
  SubscribeRequest,
  Subscription,
  SubscriptionManager,
  SubscriptionOptions,
  SubscriptionScope,
  WebhookJob,
} from './types.js';
