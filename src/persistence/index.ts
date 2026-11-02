/**
 * Persistence module — public API.
 */
export { StatePersistence } from './state-persistence.js';
export { PersistenceCoordinator } from './persistence-coordinator.js';
export type {
  SchemasSnapshot,
  DocumentTypesSnapshot,
  ChannelsSnapshot,
  SubscriptionsSnapshot,
  QuarantineSnapshot,
  EnrichmentSnapshot,
  TtlSnapshot,
  ConfigSnapshot,
} from './state-persistence.js';
