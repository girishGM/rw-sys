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
import { Audit } from '@/common/audit/decorators/audit.decorator';
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
