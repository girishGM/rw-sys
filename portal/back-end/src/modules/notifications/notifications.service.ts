/**
 * T-040 — `portal_user_notifications` read/write, and nothing else.
 *
 * ### "Own only", explicitly — implementation note 1
 *
 * *"A user may only ever see their own — `user_id = actor.id`, never merely tenant-scoped."*
 * `ScopedRepository`'s own registered strategy for `PortalUserNotification` (`scope-strategy.ts`,
 * T-013 pattern, T-040 retry 1 entry) already adds `user_id = <actor>` for every role **except**
 * `super_admin`, whose branch is `unrestricted()` — empty, by design, everywhere else in this
 * codebase, because a Super Admin's whole point is to see across tenants. A notification feed is
 * the one place that must not be true: implementation note 1 draws no role exception, and
 * 03-API-CONTRACT.md §14 backs it (`user_notifications`, own only — no super-admin carve-out is
 * written). Every method below therefore adds `userId: actor.userId` to its own `where`
 * **explicitly**, on top of whatever `ScopedRepository` contributes — redundant-but-harmless for
 * the five roles it already covers, and the only filter at all for `super_admin`. Removing it
 * would not fail a single existing test for five roles and would silently open every user's feed
 * to `super_admin` — see `notifications.service.spec.ts`'s dedicated `super_admin` case before
 * ever touching this.
 *
 * ### Why `notify()` is never called from a controller in this task
 *
 * T-040's scope is the reader (`/notifications`) and the store; the producers — campaign
 * submit/approve/reject/return (T-037/T-038), user creation (T-035), tenant activation (T-034)
 * — are separate, not-yet-built tasks outside this module's `Files owned`. `notify()` is the
 * seam they call into, exported by `NotificationsModule` for exactly that purpose. As of retry 1
 * it delivers for real, to a real `portal_users.id` recipient, for all six roles — see
 * `notifications.repository.ts`'s header for the fix and `notifications.e2e-spec.ts` for the live
 * proof against real `maker`/`checker` fixtures, which the old `admin_users`-FK'd table could
 * never represent.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotFoundError } from '@/common/errors/app-error';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { PortalUserNotification } from '@/database/portal-models/portal-user-notification.model';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import {
  NOTIFICATION_DEFAULT_PAGE_SIZE,
  NOTIFICATION_ENTITY_LABEL_LIMIT,
  NOTIFICATION_MAX_PAGE_SIZE,
  NOTIFICATION_MESSAGE_LIMIT,
  NOTIFICATION_TITLE_LIMIT,
  type NotificationType,
} from './notifications.constants';
import { NOTIFICATION_STORE, type NotificationStore } from './notifications.repository';

export interface NotifyInput {
  readonly tenantId: number;
  /** The recipient's `portal_users.id`. Never the caller's own id — see the file header. */
  readonly recipientPortalUserId: number;
  readonly notificationType: NotificationType;
  readonly title: string;
  readonly message: string;
  readonly entityType?: string | null;
  readonly entityId?: number | null;
  readonly entityLabel?: string | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

const NOTIFICATION_ID_PATTERN = /^\d+$/;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly scoped: ScopedRepository,
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStore,
  ) {}

  /** `GET /notifications` — newest first, the caller's own rows only (TC-1, TC-9). */
  async list(
    actor: AuthenticatedUser,
    page?: number,
    pageSize?: number,
  ): Promise<Page<PortalUserNotification>> {
    const resolvedPage = resolvePage(page);
    const resolvedPageSize = resolvePageSize(pageSize);

    const [items, total] = await Promise.all([
      this.scoped.listAll(PortalUserNotification, {
        where: { userId: actor.userId },
        // `id` is the tiebreaker, not decoration: several rows written in the same statement
        // (a bulk producer write, or `now()`'s statement-level stability within one transaction)
        // can share an identical `created_at` to the microsecond, and `ORDER BY created_at DESC`
        // alone is then free to return them in a different order on every call — which silently
        // breaks pagination (a row can appear on two pages, or none) and makes "mark the first
        // row read, then re-fetch it" nondeterministic, exactly the failure this project's own
        // TC-4 caught while building this task. `id` is monotonic and unique, so adding it as a
        // secondary key makes the order total rather than merely usually-stable.
        order: [
          ['createdAt', 'DESC'],
          ['id', 'DESC'],
        ],
        limit: resolvedPageSize,
        offset: (resolvedPage - 1) * resolvedPageSize,
      }),
      this.scoped.count(PortalUserNotification, { where: { userId: actor.userId } }),
    ]);

    return { items, page: resolvedPage, pageSize: resolvedPageSize, total };
  }

  /** `GET /notifications/unread-count` (TC-3). Polled every 60s by `NotificationBell` (T-023). */
  async unreadCount(actor: AuthenticatedUser): Promise<number> {
    return this.scoped.count(PortalUserNotification, {
      where: { userId: actor.userId, isRead: false },
    });
  }

  /**
   * `POST /notifications/:id/read` (TC-4, TC-6).
   *
   * A malformed id and another user's id are both a 404 for the same reason
   * `auth.controller.ts#revokeSession` gives: distinguishing them would confirm a row exists
   * that the caller may not see (02-SECURITY.md §5.1).
   */
  async markRead(actor: AuthenticatedUser, rawId: string): Promise<void> {
    if (!NOTIFICATION_ID_PATTERN.test(rawId)) throw new NotFoundError();
    const id = Number(rawId);

    const affected = await this.scoped.update(
      PortalUserNotification,
      { isRead: true, readAt: new Date() },
      { where: { id, userId: actor.userId } },
    );
    if (affected === 0) throw new NotFoundError();
  }

  /** `POST /notifications/read-all` (TC-5) — only the caller's own unread rows. */
  async markAllRead(actor: AuthenticatedUser): Promise<number> {
    return this.scoped.update(
      PortalUserNotification,
      { isRead: true, readAt: new Date() },
      { where: { userId: actor.userId, isRead: false } },
    );
  }

  /**
   * The producer-facing write. Never rejects (mirrors `AuditService`'s never-fail contract,
   * T-014 implementation note 4): a caller whose own request triggered a notification — a
   * checker approving a campaign, say — must not have *that* request fail because a downstream
   * notification could not be delivered.
   *
   * See `notifications.repository.ts` for why, as shipped, this fails for every recipient today,
   * and why that is a live escalation rather than a bug in this method.
   */
  async notify(input: NotifyInput): Promise<void> {
    try {
      await this.store.insert({
        tenantId: input.tenantId,
        recipientPortalUserId: input.recipientPortalUserId,
        notificationType: input.notificationType,
        title: clamp(input.title, NOTIFICATION_TITLE_LIMIT),
        message: clamp(input.message, NOTIFICATION_MESSAGE_LIMIT),
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        entityLabel:
          input.entityLabel === undefined || input.entityLabel === null
            ? null
            : clamp(input.entityLabel, NOTIFICATION_ENTITY_LABEL_LIMIT),
      });
    } catch (error) {
      this.logger.error(
        `NOTIFICATION WRITE FAILED — the triggering request was not affected. ` +
          `recipientPortalUserId=${String(input.recipientPortalUserId)} type=${input.notificationType}. ` +
          `Cause: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}

function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function resolvePage(page: number | undefined): number {
  return page !== undefined && page >= 1 ? Math.floor(page) : 1;
}

function resolvePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || pageSize < 1) return NOTIFICATION_DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(pageSize), NOTIFICATION_MAX_PAGE_SIZE);
}
