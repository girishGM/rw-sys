/**
 * T-014 — the public surface of the message catalogue.
 *
 * `MessageService.get(code)` is the only thing most callers need; T-015's `/me/bootstrap` uses
 * `getAll()`. `MessagesModule` is absent from this barrel for the reason the other two barrels
 * give — see `@/common/rbac/index.ts`.
 */
export * from './message.repository';
export * from './message.service';
