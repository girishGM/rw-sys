/**
 * T-038 — `/approvals` (03-API-CONTRACT.md §12).
 *
 * Thin by design, the same shape `campaigns.controller.ts` (T-037) and `merchants.controller.ts`
 * establish: read the request, call the service, shape the response. Every route carries
 * `@RequirePermission(...)` against `role_entity_permissions`; the `assertRole(actor, 'checker')`
 * that actually decides who may decide lives in the **service**, per `assert-role.ts`'s own
 * instruction — so a future CLI, a queue consumer or the AI agent backend (T-048) meets the same
 * rule this controller does.
 *
 * ### The three decisions do not share one permission
 *
 * `approve` requires `approval:approve` and `reject` requires `approval:reject`, because
 * T004_001 seeds them as two distinct actions and a Super Admin editing the Access Control screen
 * can grant one without the other — exactly the granularity 00-ARCHITECTURE.md §7's data-driven
 * model exists to provide. `return` requires `campaign:return`, which is the only `return` grant
 * that exists anywhere in the seed; see `approvals.constants.ts#RETURN_ENTITY` for the full
 * argument and for why adding an `approval:return` row was not this task's to make.
 *
 * ### Route order
 *
 * There are no `GET /:id/...` sub-resources here, so `GET /:id` is safe where it is. The three
 * `POST /:id/<verb>` routes are declared after it purely for reading order — Nest matches on
 * method as well as path, so a `POST` can never be swallowed by a `GET`.
 */
import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import type { ApprovalDetail, ApprovalRequest } from '@reward-portal/shared';
import { APPROVAL_ENTITY, RETURN_ACTION, RETURN_ENTITY } from './approvals.constants';
import { ApprovalsService } from './approvals.service';
import {
  ApproveApprovalDto,
  CommentedDecisionDto,
  ListApprovalsQueryDto,
} from './dto/approval.dto';
import { envelope, type DataEnvelope, type DataListEnvelope } from './dto/approval-response.dto';

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermission(APPROVAL_ENTITY, 'view')
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListApprovalsQueryDto,
  ): Promise<DataListEnvelope<ApprovalRequest>> {
    const { rows, meta } = await this.approvals.list(actor, query);
    return { data: rows, meta };
  }

  @Get(':id')
  @RequirePermission(APPROVAL_ENTITY, 'view')
  async findOne(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<ApprovalDetail>> {
    return envelope(await this.approvals.getDetail(actor, id));
  }

  /**
   * 200 rather than 201 — nothing addressable is created for the caller; the request it names
   * changes state, and so does the campaign behind it.
   */
  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission(APPROVAL_ENTITY, 'approve')
  @Audit({ event: 'approval_approved', targetType: 'approval_request' })
  async approve(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveApprovalDto,
  ): Promise<DataEnvelope<ApprovalRequest>> {
    return envelope(await this.approvals.approve(actor, id, dto.comment));
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission(APPROVAL_ENTITY, 'reject')
  @Audit({ event: 'approval_rejected', targetType: 'approval_request' })
  async reject(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CommentedDecisionDto,
  ): Promise<DataEnvelope<ApprovalRequest>> {
    return envelope(await this.approvals.reject(actor, id, dto.comment));
  }

  @Post(':id/return')
  @HttpCode(200)
  @RequirePermission(RETURN_ENTITY, RETURN_ACTION)
  @Audit({ event: 'approval_returned', targetType: 'approval_request' })
  async returnForRework(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CommentedDecisionDto,
  ): Promise<DataEnvelope<ApprovalRequest>> {
    return envelope(await this.approvals.returnForRework(actor, id, dto.comment));
  }
}
