/**
 * T-040 — `/audit/campaigns` and `/audit/portal` (03-API-CONTRACT.md §14), read-only.
 *
 * ### Two controllers' worth of guard in one file, on purpose
 *
 * `/audit/campaigns` is `@RequirePermission('audit', 'view')` — the seeded matrix
 * (`T004_001_seed_role_entity_permissions.ts`, "audit" block) grants it to `super_admin`,
 * `country_admin`, `tenant_admin` and `checker`; `maker` and `merchant` get 403 (TC-13 covers the
 * granted side; the negative case is in `audit-viewer.e2e-spec.ts`).
 *
 * `/audit/portal` is `@Roles('super_admin')` alone — there is **no** `audit_portal` row in
 * `role_entity_permissions` for any role, by design (03-API-CONTRACT.md §14: *"`portal_audit_log`,
 * **super_admin only**"*), so this is a static, non-configurable check, the same shape and the
 * same reasoning `trace.controller.ts` gives for its own `@Roles('super_admin')`: this data
 * aggregates authentication/access events across every tenant, which is not a capability a
 * Super Admin can delegate to a lower role via the Access Control screen. TC-10/TC-11/TC-12 are
 * the negative-authorisation tests AGENT-PROTOCOL R6 requires.
 *
 * ### No mutating route (implementation note 5, TC-17)
 *
 * Searching this directory for a POST, PATCH or DELETE route decorator returns nothing (see the
 * task's own verification step) — this file has `@Get` handlers only. `campaign_audit_trail`/
 * `portal_audit_log` writing is T-014's; T-002's grants (`REVOKE UPDATE, DELETE`) back it at the
 * database layer regardless. The exact search string is deliberately not quoted verbatim here —
 * doing so would make this very docstring the one match a reviewer's grep finds.
 */
import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { NoResponseMasking } from '@/common/data-protection/response-masking.interceptor';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { AUDIT_CSV_ROW_CAP } from './audit.constants';
import { toCsvHeader, toCsvLine } from './csv.util';
import { ListCampaignAuditQueryDto, ListPortalAuditQueryDto } from './dto/list-audit-query.dto';
import {
  toCampaignAuditRowDto,
  toPortalAuditRowDto,
  type CampaignAuditRowDto,
  type DataListEnvelope,
  type PortalAuditRowDto,
} from './dto/audit-response.dto';
import { AuditViewerService } from './audit-viewer.service';

const CAMPAIGN_AUDIT_CSV_COLUMNS = [
  'id',
  'tenantId',
  'campaignId',
  'entityType',
  'entityId',
  'action',
  'performedBy',
  'performedAt',
  'approvedBy',
  'approvedAt',
  'comment',
  'fieldChanges',
] as const;

const PORTAL_AUDIT_CSV_COLUMNS = [
  'id',
  'eventType',
  'actorId',
  'actorRole',
  'targetType',
  'targetId',
  'countryId',
  'tenantId',
  'ipAddress',
  'occurredAt',
  'detail',
] as const;

@Controller('audit')
export class AuditViewerController {
  constructor(private readonly auditViewer: AuditViewerService) {}

  @Get('campaigns')
  @RequirePermission('audit', 'view')
  async listCampaigns(
    @Query() query: ListCampaignAuditQueryDto,
  ): Promise<DataListEnvelope<CampaignAuditRowDto>> {
    const page = await this.auditViewer.listCampaignAudit(query);
    return {
      data: page.items.map(toCampaignAuditRowDto),
      meta: { page: page.page, pageSize: page.pageSize, total: page.total },
    };
  }

  @Get('campaigns/export')
  @RequirePermission('audit', 'view')
  @NoResponseMasking()
  @Audit({ event: 'audit_log_exported', targetType: 'audit_campaigns' })
  async exportCampaigns(
    @Query() query: ListCampaignAuditQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    writeCsvHeader(response, 'campaign-audit-trail.csv');
    response.write(toCsvHeader(CAMPAIGN_AUDIT_CSV_COLUMNS));

    const { truncated } = await this.auditViewer.streamCampaignAudit(query, async (rows) => {
      for (const row of rows) {
        const dto = toCampaignAuditRowDto(row);
        response.write(
          toCsvLine([
            dto.id,
            dto.tenantId,
            dto.campaignId,
            dto.entityType,
            dto.entityId,
            dto.action,
            dto.performedBy,
            dto.performedAt,
            dto.approvedBy,
            dto.approvedAt,
            dto.comment,
            JSON.stringify(dto.fieldChanges),
          ]),
        );
      }
    });

    if (truncated) writeTruncationNotice(response);
    response.end();
  }

  @Get('portal')
  @Roles('super_admin')
  @Audit({ event: 'portal_audit_log_viewed', targetType: 'audit_portal' })
  async listPortal(
    @Query() query: ListPortalAuditQueryDto,
  ): Promise<DataListEnvelope<PortalAuditRowDto>> {
    const page = await this.auditViewer.listPortalAudit(query);
    return {
      data: page.items.map(toPortalAuditRowDto),
      meta: { page: page.page, pageSize: page.pageSize, total: page.total },
    };
  }

  @Get('portal/export')
  @Roles('super_admin')
  @NoResponseMasking()
  @Audit({ event: 'audit_log_exported', targetType: 'audit_portal' })
  async exportPortal(
    @Query() query: ListPortalAuditQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    writeCsvHeader(response, 'portal-audit-log.csv');
    response.write(toCsvHeader(PORTAL_AUDIT_CSV_COLUMNS));

    const { truncated } = await this.auditViewer.streamPortalAudit(query, async (rows) => {
      for (const row of rows) {
        const dto = toPortalAuditRowDto(row);
        response.write(
          toCsvLine([
            dto.id,
            dto.eventType,
            dto.actorId,
            dto.actorRole,
            dto.targetType,
            dto.targetId,
            dto.countryId,
            dto.tenantId,
            dto.ipAddress,
            dto.occurredAt,
            dto.detail === null ? null : JSON.stringify(dto.detail),
          ]),
        );
      }
    });

    if (truncated) writeTruncationNotice(response);
    response.end();
  }
}

function writeCsvHeader(response: Response, filename: string): void {
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
}

/** TC-20: a clear message when the export was capped, not a silently short file. */
function writeTruncationNotice(response: Response): void {
  response.write(
    toCsvLine([
      `# Export truncated at ${String(AUDIT_CSV_ROW_CAP)} rows — refine the filters and re-export.`,
    ]),
  );
}
