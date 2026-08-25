/**
 * T-040 — reads `campaign_audit_trail` and `portal_audit_log`. Writing either is T-014's
 * (Scope "Out: audit writing (T-014)"); nothing here ever calls `.create()`/`.update()`/
 * `.destroy()` on either model, and there is no route in `audit-viewer.controller.ts` that
 * could reach one (implementation note 5, TC-17).
 *
 * ### Scope
 *
 * Both models already carry a registered `ScopedRepository` strategy (T-013,
 * `scope-strategy.ts`): `CampaignAuditTrail` is tenant-owned with a merchant carve-out,
 * `PortalAuditLog` scopes by country/tenant and denies `merchant` outright. `/audit/portal` is
 * additionally restricted to `super_admin` at the controller (`@Roles('super_admin')`,
 * mirroring `trace.controller.ts`'s own reasoning: cross-tenant authentication visibility is not
 * a `role_entity_permissions` grant this application ever hands to a lower role) — for that one
 * role `ScopedRepository`'s own branch is `unrestricted()`, which is correct here, unlike
 * `UserNotification`: a super_admin genuinely may see every tenant's auth events.
 */
import { Injectable } from '@nestjs/common';
import { Op, type WhereOptions } from 'sequelize';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { CampaignAuditTrail } from '@/database/models/campaign-audit-trail.model';
import { PortalAuditLog } from '@/database/portal-models/portal-audit-log.model';
import {
  AUDIT_CSV_BATCH_SIZE,
  AUDIT_CSV_ROW_CAP,
  AUDIT_DEFAULT_PAGE_SIZE,
  AUDIT_MAX_PAGE_SIZE,
} from './audit.constants';
import type {
  ListCampaignAuditQueryDto,
  ListPortalAuditQueryDto,
} from './dto/list-audit-query.dto';

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

@Injectable()
export class AuditViewerService {
  constructor(private readonly scoped: ScopedRepository) {}

  async listCampaignAudit(query: ListCampaignAuditQueryDto): Promise<Page<CampaignAuditTrail>> {
    const where = campaignAuditWhere(query);
    const page = resolvePage(query.page);
    const pageSize = resolvePageSize(query.pageSize);

    const [items, total] = await Promise.all([
      this.scoped.listAll(CampaignAuditTrail, {
        where,
        // `id` as a tiebreaker: see `notifications.service.ts#list`'s comment on the identical
        // choice — several rows written in one statement/transaction can share a `performed_at`
        // down to the microsecond, and a single-column sort is then free to reorder them between
        // calls, which breaks pagination silently.
        order: [
          ['performedAt', 'DESC'],
          ['id', 'DESC'],
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      this.scoped.count(CampaignAuditTrail, { where }),
    ]);

    return { items, page, pageSize, total };
  }

  async listPortalAudit(query: ListPortalAuditQueryDto): Promise<Page<PortalAuditLog>> {
    const where = portalAuditWhere(query);
    const page = resolvePage(query.page);
    const pageSize = resolvePageSize(query.pageSize);

    const [items, total] = await Promise.all([
      this.scoped.listAll(PortalAuditLog, {
        where,
        // `id` tiebreaker — see the identical comment on `listCampaignAudit` above.
        order: [
          ['occurredAt', 'DESC'],
          ['id', 'DESC'],
        ],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      this.scoped.count(PortalAuditLog, { where }),
    ]);

    return { items, page, pageSize, total };
  }

  /**
   * Streams `campaign_audit_trail` rows to `onBatch`, newest first, capped at
   * {@link AUDIT_CSV_ROW_CAP}. Returns whether the result was truncated by the cap (TC-20).
   */
  async streamCampaignAudit(
    query: ListCampaignAuditQueryDto,
    onBatch: (rows: readonly CampaignAuditTrail[]) => Promise<void>,
  ): Promise<{ truncated: boolean }> {
    const where = campaignAuditWhere(query);
    return this.streamRows(
      (limit, offset) =>
        this.scoped.listAll(CampaignAuditTrail, {
          where,
          order: [
            ['performedAt', 'DESC'],
            ['id', 'DESC'],
          ],
          limit,
          offset,
        }),
      onBatch,
    );
  }

  async streamPortalAudit(
    query: ListPortalAuditQueryDto,
    onBatch: (rows: readonly PortalAuditLog[]) => Promise<void>,
  ): Promise<{ truncated: boolean }> {
    const where = portalAuditWhere(query);
    return this.streamRows(
      (limit, offset) =>
        this.scoped.listAll(PortalAuditLog, {
          where,
          order: [
            ['occurredAt', 'DESC'],
            ['id', 'DESC'],
          ],
          limit,
          offset,
        }),
      onBatch,
    );
  }

  private async streamRows<T>(
    fetch: (limit: number, offset: number) => Promise<T[]>,
    onBatch: (rows: readonly T[]) => Promise<void>,
  ): Promise<{ truncated: boolean }> {
    let offset = 0;
    let delivered = 0;

    while (delivered < AUDIT_CSV_ROW_CAP) {
      const remaining = AUDIT_CSV_ROW_CAP - delivered;
      const batchSize = Math.min(AUDIT_CSV_BATCH_SIZE, remaining);
      // Fetch one row beyond the cap on the final batch, purely to detect truncation without a
      // second `COUNT` query — that extra row is never handed to `onBatch`.
      const rows = await fetch(batchSize + (remaining <= AUDIT_CSV_BATCH_SIZE ? 1 : 0), offset);
      if (rows.length === 0) return { truncated: false };

      const withinCap = rows.slice(0, batchSize);
      await onBatch(withinCap);
      delivered += withinCap.length;
      offset += withinCap.length;

      if (rows.length > withinCap.length) return { truncated: true };
      if (withinCap.length < batchSize) return { truncated: false };
    }

    return { truncated: true };
  }
}

function campaignAuditWhere(query: ListCampaignAuditQueryDto): WhereOptions {
  const clauses: WhereOptions[] = [];
  if (query.dateFrom !== undefined || query.dateTo !== undefined) {
    clauses.push({ performedAt: dateRange(query.dateFrom, query.dateTo) });
  }
  if (query.actorId !== undefined) clauses.push({ performedBy: query.actorId });
  if (query.action !== undefined) clauses.push({ action: query.action });
  if (query.entityType !== undefined) clauses.push({ entityType: query.entityType });
  if (query.campaignId !== undefined) clauses.push({ campaignId: query.campaignId });
  return clauses.length === 0 ? {} : { [Op.and]: clauses };
}

function portalAuditWhere(query: ListPortalAuditQueryDto): WhereOptions {
  const clauses: WhereOptions[] = [];
  if (query.dateFrom !== undefined || query.dateTo !== undefined) {
    clauses.push({ occurredAt: dateRange(query.dateFrom, query.dateTo) });
  }
  if (query.actorId !== undefined) clauses.push({ actorId: query.actorId });
  if (query.eventType !== undefined) clauses.push({ eventType: query.eventType });
  if (query.targetType !== undefined) clauses.push({ targetType: query.targetType });
  return clauses.length === 0 ? {} : { [Op.and]: clauses };
}

function dateRange(from: string | undefined, to: string | undefined): Record<symbol, Date> {
  const range: Record<symbol, Date> = {};
  if (from !== undefined) range[Op.gte] = new Date(from);
  if (to !== undefined) range[Op.lte] = new Date(to);
  return range;
}

function resolvePage(page: number | undefined): number {
  return page !== undefined && page >= 1 ? Math.floor(page) : 1;
}

function resolvePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || pageSize < 1) return AUDIT_DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(pageSize), AUDIT_MAX_PAGE_SIZE);
}
