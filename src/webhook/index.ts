/**
 * Webhook module — public API (Component 13)
 *
 * Exports the Webhook Dispatcher implementation and associated types.
 */

export { WebhookDispatcherImpl } from './webhook-dispatcher.js';
export type {
  DeliveryFailure,
  DeliveryFn,
  DeliveryResult,
  DeliverySuccess,
  ExpiryEnforcementMode,
  WebhookDispatcher,
  WebhookJob,
} from './types.js';
