/**
 * T-126 — `/tenants/:id/currencies` (13-REWARD-MASTER-VALUE-SOURCES.md §4).
 *
 * Same three-layer authority shape `tenants.service.ts`'s own header documents for `/tenants`
 * itself:
 *
 *  1. **Permission layer** — `role_entity_permissions` grants `tenant_currency:create/update` to
 *     `super_admin` only (T126_002 seed); every other role holds `view` only.
 *  2. **Service layer** — `assertRole(actor, 'super_admin')` at the top of every mutating method,
 *     independent of what the permission table says (the same T-013 TC-19 discipline).
 *  3. **Data layer** — `ScopedRepository`'s declared strategy for `TenantCurrency`
 *     (`scope-strategy.ts`) makes a `country_admin`/`tenant_admin`/`maker`/`checker`/`merchant`
 *     unable to reach another tenant's currency rows even if the two layers above were both
 *     wrong, and forces `tenant_id` from the request path (verified against the actor's scope by
 *     `scoped.findByPkOrFail(Tenant, tenantId)` first, exactly as `listBudgetCeilings` does) onto
 *     every read.
 *
 * `super_admin` is unrestricted at the scope layer (`buildScopeWhere` returns `null` for it —
 * `scope-strategy.ts`'s own header), so every `where: { tenantId }` clause below is this module's
 * own explicit narrowing, not something the scope layer would otherwise supply for that role —
 * the same defence-in-depth `tenants.service.ts#listBudgetCeilings` already practises.
 */
import { Injectable } from '@nestjs/common';
import { UniqueConstraintError } from 'sequelize';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { assertRole } from '@/common/rbac/assert-role';
import { AuditService } from '@/common/audit/audit.service';
import { Tenant, TenantCurrency } from '@/database/models';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { TenantCurrencyDefaultExistsError, TenantCurrencyExistsError } from './tenants.errors';
import type { CreateTenantCurrencyDto } from './dto/create-tenant-currency.dto';
import type { UpdateTenantCurrencyDto } from './dto/update-tenant-currency.dto';
import { toTenantCurrencyDto, type TenantCurrencyDto } from './dto/tenant-currency-response.dto';

@Injectable()
export class TenantCurrenciesService {
  constructor(
    private readonly scoped: ScopedRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * `GET /tenants/:id/currencies`. Every role that can see the tenant at all may read its
   * currency list (T126_002: `view` is granted to every role) — the scoped `findByPkOrFail`
   * below is what turns an out-of-scope tenant id into a 404 rather than an empty list (the same
   * "scoped lookup on Tenant first" discipline `listBudgetCeilings` documents, TC-5).
   */
  async list(tenantId: number): Promise<TenantCurrencyDto[]> {
    await this.scoped.findByPkOrFail(Tenant, tenantId);

    const rows = await this.scoped.listAll(TenantCurrency, {
      where: { tenantId },
      order: [
        ['isDefault', 'DESC'],
        ['currencyCode', 'ASC'],
      ],
    });
    return rows.map(toTenantCurrencyDto);
  }

  /** `POST /tenants/:id/currencies`. `super_admin` only (TC-2, TC-3, TC-6). */
  async create(
    actor: AuthenticatedUser,
    tenantId: number,
    dto: CreateTenantCurrencyDto,
  ): Promise<TenantCurrencyDto> {
    assertRole(actor, 'super_admin');

    await this.scoped.findByPkOrFail(Tenant, tenantId);

    let created: TenantCurrency;
    try {
      created = await this.scoped.create(TenantCurrency, {
        tenantId,
        currencyCode: dto.currencyCode,
        isDefault: dto.isDefault ?? false,
        status: 'active',
      } as never);
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        if (isDefaultConflict(error)) throw new TenantCurrencyDefaultExistsError({ cause: error });
        throw new TenantCurrencyExistsError({ cause: error });
      }
      throw error;
    }

    this.audit.annotate({
      targetId: created.id,
      detail: { tenantId, currencyCode: dto.currencyCode },
    });
    return toTenantCurrencyDto(created);
  }

  /** `PATCH /tenants/:id/currencies/:currencyId`. `super_admin` only — `status` only, the same
   * "retire, never remove" precedent `rule_category`'s own `update` establishes (T-106). */
  async update(
    actor: AuthenticatedUser,
    tenantId: number,
    currencyId: number,
    dto: UpdateTenantCurrencyDto,
  ): Promise<TenantCurrencyDto> {
    assertRole(actor, 'super_admin');

    await this.scoped.findByPkOrFail(Tenant, tenantId);
    // `findOneOrFail` with both keys explicit, not `findByPkOrFail(TenantCurrency, currencyId)`
    // alone — a currency id that exists but belongs to a *different* tenant must 404 here too,
    // not just be reachable and silently mutated under the wrong tenant's URL.
    await this.scoped.findOneOrFail(TenantCurrency, { where: { id: currencyId, tenantId } });

    if (dto.status !== undefined) {
      await this.scoped.update(TenantCurrency, { status: dto.status } as never, {
        where: { id: currencyId, tenantId },
      });
    }

    const updated = await this.scoped.findOneOrFail(TenantCurrency, {
      where: { id: currencyId, tenantId },
    });
    this.audit.annotate({ targetId: currencyId, detail: { tenantId, fields: Object.keys(dto) } });
    return toTenantCurrencyDto(updated);
  }
}

/**
 * Discriminates `uq_tc_one_default` (the partial unique index behind `is_default`) from
 * `uq_tc_tenant_currency` (the ordinary `(tenant_id, currency_code)` uniqueness).
 *
 * Not `error.fields` — unlike `tenants.service.ts#isSchemaPrefixConflict`'s two single-column
 * constraints, both constraints here include `tenant_id`, so the field list alone cannot tell
 * them apart (`uq_tc_one_default` is `(tenant_id)`; `uq_tc_tenant_currency` is
 * `(tenant_id, currency_code)`). The constraint **name** pg reports is unambiguous —
 * `database/cli/encryption-keys.ts#pgConstraint`'s own precedent for reading
 * `error.original.constraint` through a narrow, explicit cast rather than trusting the (looser)
 * declared `UniqueConstraintErrorParent` type. Falls back to `error.message` for the hand-built
 * doubles this module's own unit tests construct, which carry no real `original`.
 */
function isDefaultConflict(error: UniqueConstraintError): boolean {
  const original = (error as { original?: { constraint?: string } }).original;
  if (original?.constraint !== undefined) return original.constraint === 'uq_tc_one_default';
  return typeof error.message === 'string' && error.message.includes('uq_tc_one_default');
}
