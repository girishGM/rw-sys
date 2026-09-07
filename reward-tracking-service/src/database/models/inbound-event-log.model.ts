/**
 * `reward_tracking.inbound_event_log` — `brain-storm/02-DATA-MODEL.md` §1.1. This service's
 * migrations are raw SQL, not `sequelize-typescript` `@Table` models (matching every sibling
 * service's own convention — see `realtime-activity-processing-service`'s
 * `campaign-config-snapshot.model.ts` header for the precedent). These `models/*.ts` files are the
 * shared, schema-level source of truth for each table's raw row shape (snake_case, exactly as
 * Postgres/`pg` returns it) — the one place every later task's own module-level repository/entity
 * imports from, instead of each re-declaring the same columns.
 */
export type InboundEventChannel = 'KAFKA' | 'GRPC' | 'REST';
export type InboundEventProcessingStatus = 'received' | 'applied' | 'duplicate' | 'failed';

export interface InboundEventLogRow {
  id: string;
  reward_entry_id: string;
  received_channel: InboundEventChannel;
  payload: unknown;
  received_at: Date;
  processed_at: Date | null;
  processing_status: InboundEventProcessingStatus;
  error_message: string | null;
}
