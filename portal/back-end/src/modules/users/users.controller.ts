/**
 * T-035 — `/users` (03-API-CONTRACT.md §7).
 *
 * Thin by design, the same shape `tenants.controller.ts`/`countries.controller.ts` establish:
 * read the request, call the service, shape the response. Every route carries
 * `@RequirePermission` (`role_entity_permissions`, entity `user` — T004_001's seed); the
 * role-creation matrix itself is enforced in `UsersService`, not here (this task's own risk
 * flag — see `users.service.ts`'s header for the full three-layer argument).
 *
 * T-088/F-12: `update()` now takes `@CurrentUser()` too, purely so `UsersService.update()` can
 * run the same role-floor check `deactivate()`/`resetPassword()` already had the actor for — see
 * `users.service.ts`'s header, "T-088 / finding F-12".
 *
 * ### T-128 — `GET`/`PATCH /users/me/preferences`, deliberately *not* `@RequirePermission`
 *
 * Every other route here is gated by `user:view`/`user:create`/`user:update` — an admin acting on
 * *someone else's* row. This one is the caller acting on their **own** row (the target id is
 * `actor.userId` from the verified JWT, never a route/body parameter — AGENT-PROTOCOL R3, and
 * TC-6's own point: there is no id parameter on this route for a token to spoof), so gating it on
 * `user:update` would be wrong twice over — it would let a `super_admin` lock every other role out
 * of setting their own theme by editing one Access Control row, and it would conflate "may manage
 * other users" with "may pick your own theme", which 03-API-CONTRACT.md §6's implementation note
 * for this task states must not be the same permission. `@Roles(...ALL_PORTAL_ROLES)` is the
 * `me.controller.ts` precedent for exactly this shape (see that file's own header) — every
 * authenticated role admitted, no `@RequirePermission` at all, so `PermissionsGuard` passes it
 * through once `RolesGuard`'s role check clears (TC-4).
 *
 * Both handlers are declared **before** `findOne(':id')`/`update(':id')` below: Nest resolves a
 * `GET`/`PATCH` route in declaration order, so `me/preferences` must be seen before `:id` or
 * `me` would be captured as the `:id` parameter and rejected by `ParseIntPipe`.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsIn } from 'class-validator';
import { UI_THEMES, type UiTheme } from '@reward-portal/shared';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import type { RequestContext } from '@/modules/auth/services/session.service';
import { USER_ENTITY } from './users.constants';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  envelope,
  type DataEnvelope,
  type DataListEnvelope,
  type UserDto,
} from './dto/user-response.dto';
import type { UserCreatedResponseDto } from './dto/user-created-response.dto';

/**
 * `PATCH /users/me/preferences`'s body — the one field 13-REWARD-MASTER-VALUE-SOURCES.md §6
 * names. `@IsIn(UI_THEMES)` reuses the same three-value list `@reward-portal/shared` and
 * `ck_portal_users_ui_theme` (`T128_001`) both enforce, rather than a fourth, independently
 * spelled union — an invalid value is a 400 from the global `ValidationPipe`
 * (`forbidNonWhitelisted` also refuses any other key) before this class is ever inspected again.
 */
class UpdateUserPreferencesDto {
  @IsIn(UI_THEMES)
  uiTheme!: UiTheme;
}

/** `GET`/`PATCH /users/me/preferences`'s response body. */
export interface UserPreferencesDto {
  readonly uiTheme: UiTheme;
}

/** `request.ip`/`user-agent` for the audit trail a session revocation writes — the same shape
 * `tenants.controller.ts`'s own local `requestContext` helper builds, duplicated here rather
 * than imported since `back-end/src/modules/auth/**` is outside this task's file scope. */
function requestContext(request: Request): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission(USER_ENTITY, 'view')
  async list(@Query() query: ListUsersQueryDto): Promise<DataListEnvelope<UserDto>> {
    const { rows, meta } = await this.users.list(query);
    return { data: rows, meta };
  }

  /**
   * `GET /users/me/preferences` — T-128. Declared ahead of `findOne(':id')` — see this file's
   * own header for why the order matters.
   */
  @Get('me/preferences')
  @Roles(...ALL_PORTAL_ROLES)
  async getMyPreferences(
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DataEnvelope<UserPreferencesDto>> {
    return envelope(await this.users.getPreferences(actor));
  }

  /**
   * `PATCH /users/me/preferences` — T-128. Declared ahead of `update(':id')` for the same
   * ordering reason as `getMyPreferences` above.
   */
  @Patch('me/preferences')
  @Roles(...ALL_PORTAL_ROLES)
  @Audit({ event: 'user_preferences_updated', targetType: 'portal_user' })
  async updateMyPreferences(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: UpdateUserPreferencesDto,
  ): Promise<DataEnvelope<UserPreferencesDto>> {
    return envelope(await this.users.updatePreferences(actor, dto.uiTheme));
  }

  @Get(':id')
  @RequirePermission(USER_ENTITY, 'view')
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<DataEnvelope<UserDto>> {
    return envelope(await this.users.getById(id));
  }

  @Post()
  @RequirePermission(USER_ENTITY, 'create')
  @Audit({ event: 'user_created', targetType: 'user' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateUserDto,
  ): Promise<DataEnvelope<UserCreatedResponseDto>> {
    return envelope(await this.users.create(actor, dto));
  }

  @Patch(':id')
  @RequirePermission(USER_ENTITY, 'update')
  @Audit({ event: 'user_updated', targetType: 'user' })
  async update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ): Promise<DataEnvelope<UserDto>> {
    return envelope(await this.users.update(actor, id, dto));
  }

  @Post(':id/deactivate')
  @RequirePermission(USER_ENTITY, 'update')
  @Audit({ event: 'user_deactivated', targetType: 'user' })
  async deactivate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<DataEnvelope<UserDto>> {
    return envelope(await this.users.deactivate(actor, id, requestContext(request)));
  }

  @Post(':id/reset-password')
  @RequirePermission(USER_ENTITY, 'update')
  @Audit({ event: 'user_password_reset', targetType: 'user' })
  async resetPassword(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<DataEnvelope<UserCreatedResponseDto>> {
    return envelope(await this.users.resetPassword(actor, id, requestContext(request)));
  }
}
