/**
 * T-040 — the one write this module makes that `ScopedRepository` cannot: creating a
 * notification **for someone other than the caller**.
 *
 * ### Why this is not `ScopedRepository.create()`
 *
 * `ScopedRepository.create()` (T-013) forces every scope column it knows about — for
 * `PortalUserNotification` that is `user_id` (`scope-strategy.ts`: `column('userId', 'user')`)
 * — to the **acting** user's own scope value, last, overriding whatever the caller supplied
 * (`scoped.repository.ts`, "the scope columns are written last, over whatever the caller
 * supplied"). That is exactly right for every other model it protects (a maker can only ever
 * create a campaign in their own tenant), and exactly wrong here: a checker who approves a
 * campaign must be able to write a notification **to the maker**, not to themself. Routing a
 * fan-out write through `ScopedRepository` would silently notify the wrong person on every call.
 *
 * This mirrors `common/audit/audit.repository.ts`'s own reasoning for the same shape of problem
 * (`insertPortalEvent`/`insertDomainEvent` are raw SQL for the same reason), and reuses its
 * pattern: a narrow, append-only insert with every value bound through `replacements`, never
 * string-built from a request.
 *
 * ### `user_id` — resolved, not merely escalated (T-040 retry 1)
 *
 * The first submission of this task inserted into `reward_config.user_notifications`, whose
 * `user_id` carries `fk_un_user → reward_config.admin_users(id)` — verified live to reject
 * every real recipient, because the portal's identity table (`reward_portal.portal_users`) and
 * `admin_users` are two unrelated id spaces, and `maker`/`checker` cannot be stored in
 * `admin_users` at all (`ck_admin_users_role`, 00-ARCHITECTURE.md §5.2 gap G1). That review
 * failure is the same structural gap T-014 first raised for `campaign_audit_trail.performed_by`.
 *
 * The fix is `reward_portal.portal_user_notifications` (`T040_001_portal_user_notifications.ts`)
 * — a column-for-column mirror of the old table with `user_id` referencing
 * `reward_portal.portal_users(id)` directly, the same pattern this schema already uses twice for
 * the identical reason (`portal_users` itself, `portal_user_credentials`). This insert now
 * targets that table, and a direct write for every one of the six roles succeeds — proved live in
 * `notifications.e2e-spec.ts`, including real `maker`/`checker` recipients that the FK made
 * structurally impossible before this migration.
 *
 * `notify()` stays wrapped in the same never-fail contract `AuditService` uses (T-014
 * implementation note 4): a caller whose own request triggers a notification must never have
 * *that* request fail because a downstream notification could not be written, for whatever
 * reason (a future data issue, a pool exhaustion, and so on) — the never-fail contract was never
 * about this FK specifically, and stays regardless of it now being resolved.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import type { NotificationType } from './notifications.constants';

export interface NotificationInsert {
  readonly tenantId: number;
  /** The recipient's `portal_users.id` — never the acting caller's. */
  readonly recipientPortalUserId: number;
  readonly notificationType: NotificationType;
  readonly title: string;
  readonly message: string;
  readonly entityType?: string | null;
  readonly entityId?: number | null;
  readonly entityLabel?: string | null;
}

/** What `NotificationsService` depends on. Implemented below; faked in unit tests. */
export interface NotificationStore {
  insert(row: NotificationInsert): Promise<void>;
}

/** DI token — consumers depend on {@link NotificationStore}, never on the class. */
export const NOTIFICATION_STORE = Symbol('NOTIFICATION_STORE');

@Injectable()
export class NotificationsRepository implements NotificationStore {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async insert(row: NotificationInsert): Promise<void> {
    await this.sequelize.query(
      `
      INSERT INTO reward_portal.portal_user_notifications
             (tenant_id, user_id, notification_type, title, message,
              entity_type, entity_id, entity_label)
      VALUES (:tenantId, :userId, :notificationType, :title, :message,
              :entityType, :entityId, :entityLabel)
      `,
      {
        type: QueryTypes.INSERT,
        replacements: {
          tenantId: row.tenantId,
          userId: row.recipientPortalUserId,
          notificationType: row.notificationType,
          title: row.title,
          message: row.message,
          entityType: row.entityType ?? null,
          entityId: row.entityId ?? null,
          entityLabel: row.entityLabel ?? null,
        },
      },
    );
  }
}
