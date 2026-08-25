/**
 * T-040 — `/notifications`: the in-app feed every authenticated user reads (03-API-CONTRACT.md
 * §14).
 *
 * ### `@RequirePermission('notification', ...)`, no `@Roles`
 *
 * `role_entity_permissions` already seeds `notification:view`/`notification:update` for all six
 * roles (`T004_001_seed_role_entity_permissions.ts` — "notification — every role"), so a single
 * `@RequirePermission` carries the whole authorisation decision. `RolesGuard` accepts a route
 * guarded by `@RequirePermission` alone as "declares authorisation metadata" (T-013 TC-18;
 * `route-authorisation.ts` note 6) — the same shape `me.controller.ts` chose the opposite way
 * (`@Roles(...ALL_PORTAL_ROLES)`, no `@RequirePermission`) for the same "every role" outcome,
 * because `/me` is the caller's own identity rather than an entity in the permission table.
 * A notification feed *is* such an entity — Super Admin can revoke it from a role without a
 * code change — so this module uses the table.
 *
 * No route here is audited (`@Audit()`): these are routine self-service actions on the caller's
 * own rows, not governance events `campaign_audit_trail`/`portal_audit_log` exist to record.
 */
import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import {
  envelope,
  toNotificationDto,
  type DataEnvelope,
  type DataListEnvelope,
  type MarkAllReadResultDto,
  type NotificationDto,
  type UnreadCountDto,
} from './dto/notification-response.dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission('notification', 'view')
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<DataListEnvelope<NotificationDto>> {
    const page = await this.notifications.list(actor, query.page, query.pageSize);
    return {
      data: page.items.map(toNotificationDto),
      meta: { page: page.page, pageSize: page.pageSize, total: page.total },
    };
  }

  @Get('unread-count')
  @RequirePermission('notification', 'view')
  async unreadCount(
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DataEnvelope<UnreadCountDto>> {
    const count = await this.notifications.unreadCount(actor);
    return envelope({ count });
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('notification', 'update')
  async markRead(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DataEnvelope<{ id: string }>> {
    await this.notifications.markRead(actor, id);
    return envelope({ id });
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('notification', 'update')
  async markAllRead(
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DataEnvelope<MarkAllReadResultDto>> {
    const affected = await this.notifications.markAllRead(actor);
    return envelope({ affected });
  }
}
