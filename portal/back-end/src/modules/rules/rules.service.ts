/**
 * T-031 — `/rules`: Super Admin authors global rules; every other role only reads what is
 * assigned to their country (00-ARCHITECTURE.md §5.2, 01-DATABASE.md §4).
 *
 * ### The three independent layers behind every write here
 *
 * 1. **Permission layer** — `role_entity_permissions` grants `rule:create/update/delete` and
 *    `rule_assignment:create/delete` to `super_admin` only (T004_001 seed, 01-DATABASE.md
 *    §5.1). Enforced by `@RequirePermission` in `rules.controller.ts`.
 * 2. **Service layer** — `assertRole(actor, 'super_admin')` at the top of every mutating
 *    method here, independent of what the permission table says (T-013's `assertRole`,
 *    T-013 TC-19). **TC-3 is the test that proves this layer holds even when layer 1 is
 *    misconfigured** — see the module's completion report.
 * 3. **Data layer** — every write below sets `tenant_id = NULL` explicitly (never inferred),
 *    and `create`/`update`/`update`/`destroy` all route through `ScopedRepository`, whose
 *    `RuleMaster`/`RuleCountryAssignment` scope-strategy entries (T-013,
 *    `common/scope/scope-strategy.ts`) make a non-super-admin actor structurally unable to
 *    reach this service's write paths at all — `PermissionsGuard`/`RolesGuard` already stop
 *    them before layer 2 is even reached, and layer 2 stops them again if either guard were
 *    ever bypassed.
 *
 * ### Read visibility — implementation note 3's `ruleVisibilityScope(countryId)`
 *
 * `common/scope/scope-strategy.ts`'s own `RuleMaster` entry (T-013) already **is** that
 * helper: *"T-031's `ruleVisibilityScope(countryId)` helper must be built on this entry
 * rather than beside it"* (that file's own comment, written for this task in advance). A
 * hand-written `WHERE rm.tenant_id IS NULL AND EXISTS (…)` clause per endpoint — the literal
 * SQL this task's own implementation note 3 shows — would be a **second**, independently
 * maintained copy of exactly the subquery `RULES_ASSIGNED_TO_COUNTRY` already compiles for
 * every non-super-admin role through `ScopedRepository.listAll`/`findByPkOrFail`. This
 * service therefore never constructs that clause itself: every read below is a plain
 * `this.scoped.*` call, and the country-assignment gate is enforced once, in the one place
 * T-013 already proved correct (100% branch coverage on `scope-strategy.ts`, per that task's
 * own completion report) — see the module's completion report for the full reasoning and the
 * conflict this resolves with the task file's literal wording (AGENT-PROTOCOL §3).
 */
import { Inject, Injectable } from '@nestjs/common';
import { Op, UniqueConstraintError } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ruleParametersSchema } from '@reward-portal/shared';
import { SEQUELIZE } from '@/database/sequelize.provider';
import {
  Country,
  FieldApiLookupProvider,
  FieldContextProvider,
  RuleCategory,
  RuleCountryAssignment,
  RuleMaster,
  RuleResolver,
  RuleSubCategory,
  RuleVersion,
} from '@/database/models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { ValidationFailedError } from '@/common/errors/app-error';
import { PortalUser } from '@/database/portal-models';
import { assertRole } from '@/common/rbac/assert-role';
import { AuditService } from '@/common/audit/audit.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { findActiveCampaignsUsingRuleInCountry } from './campaign-usage.query';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './rules.constants';
import {
  RuleCategoryCodeExistsError,
  RuleCodeExistsError,
  RuleHasCountryAssignmentsError,
  RuleInUseByCampaignError,
  RuleSubCategoryCodeExistsError,
  UnknownFieldValueSourceProviderError,
} from './rules.errors';
import type { AssignRuleCountryDto } from './dto/assign-rule-country.dto';
import type { CreateRuleDto } from './dto/create-rule.dto';
import type { CreateRuleCategoryDto } from './dto/create-rule-category.dto';
import type { CreateRuleSubCategoryDto } from './dto/create-rule-sub-category.dto';
import type { RuleSortField, ListRulesQueryDto } from './dto/list-rules-query.dto';
import type { UpdateRuleDto } from './dto/update-rule.dto';
import type { UpdateRuleCategoryDto } from './dto/update-rule-category.dto';
import type { UpdateRuleSubCategoryDto } from './dto/update-rule-sub-category.dto';
import {
  toRuleCategoryDto,
  toRuleCountryAssignmentDto,
  toRuleDto,
  toRuleParametersDto,
  toRuleSubCategoryDto,
  withParameterFieldRoles,
  type ListMeta,
  type RuleCategoryDto,
  type RuleCountryAssignmentDto,
  type RuleDto,
  type RuleSubCategoryDto,
  type RuleWithCategory,
} from './dto/rule-response.dto';

const SORT_COLUMN: Readonly<Record<RuleSortField, string>> = Object.freeze({
  ruleCode: 'ruleCode',
  name: 'name',
  createdAt: 'createdAt',
  status: 'status',
});

/** The eager-load every read path in this module needs — `toRuleDto` reads `subCategory.category`
 * without a guard, so every query that can reach it loads both levels. */
const WITH_CATEGORY = Object.freeze({
  include: [{ model: RuleSubCategory, include: [RuleCategory] }],
});

@Injectable()
export class RulesService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly audit: AuditService,
  ) {}

  // --- reads -----------------------------------------------------------------------------

  /**
   * `GET /rules`. Visibility is decided entirely by `ScopedRepository` — see this file's
   * header. `tenantId: null` is applied on top regardless of role: this endpoint's whole
   * purpose is the portal-managed catalogue of **global** rules (implementation note 1), and
   * a legacy tenant-local `rule_master` row this portal does not author must never appear in
   * it, super_admin included (TC-6: "All global rules").
   *
   * T-111 — `categoryId`/`subCategoryId`/`search` narrow the same scoped query further, exactly
   * like `status` already does; none of the three carry any authority (R3 — visibility is scope
   * alone, decided above `where` is even built).
   */
  async list(query: ListRulesQueryDto): Promise<{ rows: RuleDto[]; meta: ListMeta }> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const [field, direction] = parseSort(query.sort);

    const where: Record<string, unknown> = { tenantId: null };
    if (query.status !== undefined) where['status'] = query.status;

    // The more specific ask wins — an exact `subCategoryId` never needs the category rolled up
    // first (implementation note 2). Only when no exact sub-category is given does `categoryId`
    // resolve to the set of sub-category ids under it.
    if (query.subCategoryId !== undefined) {
      where['subCategoryId'] = query.subCategoryId;
    } else if (query.categoryId !== undefined) {
      where['subCategoryId'] = { [Op.in]: await this.resolveSubCategoryIds(query.categoryId) };
    }

    if (query.search !== undefined && query.search.trim() !== '') {
      const term = `%${query.search.trim()}%`;
      // `Object.assign`, not a bracket assignment — `Op.or` is a `Symbol`, and `where` is typed
      // `Record<string, unknown>` for the plain string-keyed filters above; this is the same
      // "merge a search clause onto the rest of the filters" shape `campaigns.service.ts#buildWhere`
      // uses, just applied in place rather than building a separate clause array, since every
      // other filter here is a single equality/`Op.in` check, never itself an `Op.or`.
      Object.assign(where, {
        [Op.or]: [{ ruleCode: { [Op.iLike]: term } }, { name: { [Op.iLike]: term } }],
      });
    }

    const rows = await this.scoped.listAll(RuleMaster, {
      where,
      ...WITH_CATEGORY,
      order: [[SORT_COLUMN[field], direction.toUpperCase()]],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const total = await this.scoped.count(RuleMaster, { where });

    // T-114 — batched, not one resolver-input-field-keys lookup per row: see
    // {@link resolveInputFieldKeysByRule}'s own comment for why this is safe to do in one query
    // pair regardless of row order.
    const keysByRule = await this.resolveInputFieldKeysByRule(rows.map((row) => row.id));
    return {
      rows: rows.map((row) => this.annotateRoles(toRuleDto(row as RuleWithCategory), keysByRule)),
      meta: { page, pageSize, total },
    };
  }

  /** `GET /rules/:id`. 404 for absent **or** out-of-scope (TC-8) — the two are
   * indistinguishable by construction (`ScopedRepository.findByPkOrFail`). */
  async getById(id: number): Promise<RuleDto> {
    const rule = await this.findGlobalRuleOrFail(id);
    return this.withParameterRoles(toRuleDto(rule));
  }

  /** `GET /rules/:id/parameters` (TC-15) — every role that can see the rule at all. */
  async getParameters(id: number): Promise<Record<string, unknown>> {
    const rule = await this.scoped.findByPkOrFail(RuleMaster, id, { where: { tenantId: null } });
    const keys = await this.resolveInputFieldKeys(id);
    return withParameterFieldRoles(toRuleParametersDto(rule), keys);
  }

  /** `GET /rules/:id/countries`. `super_admin` only (enforced at the controller). */
  async listCountryAssignments(ruleId: number): Promise<RuleCountryAssignmentDto[]> {
    await this.findGlobalRuleOrFail(ruleId);
    const rows = await this.scoped.listAll(RuleCountryAssignment, {
      where: { ruleId },
      include: [Country],
      order: [['assignedAt', 'ASC']],
    });
    return rows.map((row) =>
      toRuleCountryAssignmentDto(row as RuleCountryAssignment & { country: Country }),
    );
  }

  // --- writes ------------------------------------------------------------------------------

  /**
   * `POST /rules`. Layer 2 + layer 3 of this file's header.
   *
   * ### Why `ruleCode` uniqueness is checked here, not left to `uq_rm_tenant_code` alone
   *
   * `uq_rm_tenant_code` is a composite unique constraint on `(tenant_id, rule_code)`, and
   * standard SQL (Postgres's default, pre-15 `NULLS DISTINCT` behaviour) treats every `NULL`
   * as distinct from every other `NULL` for uniqueness purposes — confirmed live, not assumed:
   * two global rules (`tenant_id IS NULL`) sharing a `rule_code` do **not** violate this
   * constraint, so `TC-18` ("duplicate ruleCode → 409") cannot be satisfied by the `catch`
   * below alone the way `countries.service.ts`'s `insertCountry` relies on
   * `UniqueConstraintError` for `uq_countries_code`. A `NULLS NOT DISTINCT` index would close
   * this properly, but adding one is new DDL against `reward_config`, which AGENT-PROTOCOL R1
   * forbids outside T-002's two authorised `DROP NOT NULL` statements — escalated in the
   * completion report, not silently worked around with a schema change. The explicit check
   * below is the same accepted trade-off `countries.service.ts#assertHqAvailable` documents for
   * `is_hq` (*"narrows, but does not close, the TOCTOU window"*): real inside the same
   * transaction as the insert, not eliminated by it. The `UniqueConstraintError` catch stays as
   * a second, defence-in-depth layer for the (unlikely, but real once T-002's originally-`NOT
   * NULL` tenant-scoped rows are considered) case where two rows do share a non-null
   * `tenant_id`.
   */
  async create(actor: AuthenticatedUser, dto: CreateRuleDto): Promise<RuleDto> {
    assertRole(actor, 'super_admin');

    // T-122 — before any write: every `valueSource` a field declares must name a provider that
    // actually exists. See {@link assertValueSourceProvidersExist}.
    await this.assertValueSourceProvidersExist(dto.parameters);

    const duplicateCount = await this.scoped.count(RuleMaster, {
      where: { tenantId: null, ruleCode: dto.ruleCode },
    });
    if (duplicateCount > 0) throw new RuleCodeExistsError();

    const createdBy = await this.resolveAdminUserId(actor);

    let created: RuleMaster;
    try {
      // `as never` — the same `sequelize-typescript`/`CreationAttributes<M>` gap
      // `countries.service.ts#insertCountry` documents at length: these model classes declare
      // a single `Model<M>` type parameter, so `CreationAttributes<M>` resolves to the whole
      // instance shape rather than just the writable columns. `never` is assignable to any
      // parameter type; every field name below is still checked structurally by nothing else,
      // but a typo would still be caught at runtime by the `NOT NULL` columns it omits.
      created = await this.scoped.create(RuleMaster, {
        // Explicit, not inferred — layer 3 of this file's header. A non-super-admin can
        // never reach this line (guards + `assertRole` above), and `super_admin`'s own scope
        // carries no tenant to infer one from even if it could.
        tenantId: null,
        subCategoryId: dto.subCategoryId,
        ruleCode: dto.ruleCode,
        name: dto.name.trim(),
        expression: dto.expression ?? null,
        // `{ fields: [] }`, not a bare `{}` — the canonical "no parameters" shape
        // `packages/shared/src/rule.schema.ts#ruleParametersSchema` documents (T-074: the two
        // were previously not interchangeable at this schema, which broke every newly created
        // rule with no `parameters` supplied). The schema now tolerates a bare `{}` too (it has
        // to, to keep faith with `rule-master.model.ts`'s own "never throws" fallback for
        // malformed legacy content), but this write path uses the explicit, self-describing
        // form rather than leaning on that tolerance for its own normal case.
        parameters: dto.parameters ?? { fields: [] },
        // See {@link resolveAdminUserId}'s own comment — never `actor.userId` directly.
        createdBy,
        status: 'active',
      } as never);
    } catch (error) {
      if (error instanceof UniqueConstraintError) throw new RuleCodeExistsError({ cause: error });
      throw error;
    }

    this.audit.annotate({ targetId: created.id, detail: { ruleCode: created.ruleCode } });
    const withCategory = await this.findGlobalRuleOrFail(created.id);
    return this.withParameterRoles(toRuleDto(withCategory));
  }

  /** `PATCH /rules/:id`. Layer 2 + layer 3. Audited with a field diff (TC-19). */
  async update(actor: AuthenticatedUser, id: number, dto: UpdateRuleDto): Promise<RuleDto> {
    assertRole(actor, 'super_admin');

    // T-122 — same gate as `create`: a rule may not be *edited* into referencing a provider that
    // does not exist either. Runs before the row is read, so a bad `valueSource` cannot depend on
    // whether the rule happens to exist.
    await this.assertValueSourceProvidersExist(dto.parameters);

    const before = await this.findGlobalRuleOrFail(id);
    const changes = collectRuleChanges(dto);

    if (Object.keys(changes).length > 0) {
      await this.scoped.update(RuleMaster, changes, { where: { id, tenantId: null } });
    }

    const after = await this.findGlobalRuleOrFail(id);
    this.audit.annotate({
      targetId: id,
      detail: { changes: this.audit.diffFields(fieldSnapshot(before), fieldSnapshot(after)) },
    });
    return this.withParameterRoles(toRuleDto(after));
  }

  /**
   * `DELETE /rules/:id`. Layer 2 + layer 3. Refuses while any country assignment remains
   * (TC-20 — "unassign first"), listing the blocking country ids.
   *
   * `rule_master` carries no `deleted_at` (T-003's model is deliberately not `paranoid` — see
   * `rule-master.model.ts`'s own test assertion), so there is no soft-delete column to write:
   * this is a genuine row removal, not a status flip. `reward_app` is independently confirmed
   * to hold live `DELETE` privilege on `reward_config.rule_master` (checked against the real
   * database with `has_table_privilege()` — 01-DATABASE.md §3's own documented `GRANT` list
   * does not mention `DELETE` at all, so this was verified rather than assumed; flagged for
   * the reviewer as a doc/reality gap worth a follow-up, independent of this task).
   */
  async remove(actor: AuthenticatedUser, id: number): Promise<void> {
    assertRole(actor, 'super_admin');
    await this.findGlobalRuleOrFail(id);

    const assignments = await this.scoped.listAll(RuleCountryAssignment, { where: { ruleId: id } });
    if (assignments.length > 0) {
      throw new RuleHasCountryAssignmentsError(assignments.map((row) => row.countryId));
    }

    await this.scoped.destroy(RuleMaster, { where: { id, tenantId: null } });
    this.audit.annotate({ targetId: id, detail: { event: 'rule_deleted' } });
  }

  /**
   * `POST /rules/:id/countries`. Layer 2 + layer 3. Idempotent (TC-11): assigning the same
   * rule to the same country twice returns the existing row rather than a duplicate — the
   * unique constraint (`uq_rule_country_assignments`) is the backstop, not the primary
   * mechanism, so a benign double-click never surfaces as an error.
   */
  async assignToCountry(
    actor: AuthenticatedUser,
    ruleId: number,
    dto: AssignRuleCountryDto,
  ): Promise<RuleCountryAssignmentDto> {
    assertRole(actor, 'super_admin');
    await this.findGlobalRuleOrFail(ruleId);
    // 404s a bogus/out-of-scope country id before any write is attempted.
    await this.scoped.findByPkOrFail(Country, dto.countryId);
    const assignedBy = await this.resolveAdminUserId(actor);

    return this.sequelize.transaction(async (transaction) => {
      // `count` + `findOneOrFail` rather than a bare `findOne` — `findOne` is one of the
      // Sequelize-API method names `no-raw-model-access` bans on *any* receiver, `this.scoped`
      // included (`scoped.repository.ts`'s header: only `listAll`/`findByPkOrFail`/
      // `findOneOrFail` are names Sequelize's own `Model` API does not have, which is what
      // makes them the lintable-safe way to reach this class from `src/modules/**`).
      const alreadyAssignedCount = await this.scoped.count(RuleCountryAssignment, {
        where: { ruleId, countryId: dto.countryId },
        transaction,
      });
      if (alreadyAssignedCount > 0) {
        const existing = await this.scoped.findOneOrFail(RuleCountryAssignment, {
          where: { ruleId, countryId: dto.countryId },
          include: [Country],
          transaction,
        });
        return toRuleCountryAssignmentDto(existing as RuleCountryAssignment & { country: Country });
      }

      let created: RuleCountryAssignment;
      try {
        created = await this.scoped.create(
          RuleCountryAssignment,
          {
            ruleId,
            countryId: dto.countryId,
            // See {@link resolveAdminUserId}'s own comment — never `actor.userId` directly.
            assignedBy,
          } as never,
          { transaction },
        );
      } catch (error) {
        // A concurrent request won the race between the `findOne` above and this insert —
        // `uq_rule_country_assignments` is the backstop TC-11 names explicitly. Re-read rather
        // than surface a 409 for what is, from the caller's point of view, a successful assign.
        if (error instanceof UniqueConstraintError) {
          const raced = await this.scoped.findOneOrFail(RuleCountryAssignment, {
            where: { ruleId, countryId: dto.countryId },
            include: [Country],
            transaction,
          });
          this.audit.annotate({ targetId: raced.id, detail: { ruleId, countryId: dto.countryId } });
          return toRuleCountryAssignmentDto(raced as RuleCountryAssignment & { country: Country });
        }
        throw error;
      }

      this.audit.annotate({
        targetId: created.id,
        targetType: 'rule_assignment',
        detail: { ruleId, countryId: dto.countryId },
      });
      const withCountry = await this.scoped.findOneOrFail(RuleCountryAssignment, {
        where: { id: created.id },
        include: [Country],
        transaction,
      });
      return toRuleCountryAssignmentDto(
        withCountry as RuleCountryAssignment & { country: Country },
      );
    });
  }

  /**
   * `DELETE /rules/:id/countries/:countryId`. Layer 2 + layer 3. Refuses when an active
   * campaign in `countryId` is bound to `ruleId` (implementation note 6, TC-12) — 422 listing
   * the blocking campaigns; the assignment row is left untouched.
   */
  async unassignFromCountry(
    actor: AuthenticatedUser,
    ruleId: number,
    countryId: number,
  ): Promise<void> {
    assertRole(actor, 'super_admin');
    await this.findGlobalRuleOrFail(ruleId);

    const assignment = await this.scoped.findOneOrFail(RuleCountryAssignment, {
      where: { ruleId, countryId },
    });

    const campaigns = await findActiveCampaignsUsingRuleInCountry(
      this.sequelize,
      ruleId,
      countryId,
    );
    if (campaigns.length > 0) {
      throw new RuleInUseByCampaignError(campaigns);
    }

    await this.scoped.destroy(RuleCountryAssignment, { where: { id: assignment.id } });
    this.audit.annotate({
      targetId: assignment.id,
      targetType: 'rule_assignment',
      detail: { ruleId, countryId },
    });
  }

  // --- reference data (all roles) ----------------------------------------------------------

  /**
   * `GET /rule-categories`. Read-only reference data, reachable by every role
   * (03-API-CONTRACT.md §8). Still routed through `ScopedRepository`, per R2 — T-013 already
   * declared `RuleCategory`/`RuleSubCategory` as `unrestricted()` for every role in
   * `scope-strategy.ts` precisely for this case (*"reserved for genuinely global, Super
   * Admin-owned configuration and reference data"*), so this is a plain `listAll` like every
   * other read in this module, not a raw `Model.findAll()`.
   */
  async listCategories(): Promise<RuleCategoryDto[]> {
    const rows = await this.scoped.listAll(RuleCategory, { order: [['name', 'ASC']] });
    return rows.map(toRuleCategoryDto);
  }

  /** `GET /rule-sub-categories`. See {@link listCategories}. */
  async listSubCategories(categoryId?: number): Promise<RuleSubCategoryDto[]> {
    const where = categoryId === undefined ? {} : { categoryId };
    const rows = await this.scoped.listAll(RuleSubCategory, { where, order: [['name', 'ASC']] });
    return rows.map(toRuleSubCategoryDto);
  }

  /**
   * T-106 — `POST /rule-categories`. `super_admin` only (layer 2, mirroring `create()`'s own
   * `assertRole`). Always `tenant_id = 1` — matching every existing category row and the
   * read path's own "unrestricted, tenant_id is a NOT NULL technicality, not a real scope"
   * treatment (`listCategories`'s own comment) — never a tenant picker in the request.
   */
  async createCategory(
    actor: AuthenticatedUser,
    dto: CreateRuleCategoryDto,
  ): Promise<RuleCategoryDto> {
    assertRole(actor, 'super_admin');

    const duplicateCount = await this.scoped.count(RuleCategory, {
      where: { tenantId: 1, categoryCode: dto.categoryCode },
    });
    if (duplicateCount > 0) throw new RuleCategoryCodeExistsError();

    let created: RuleCategory;
    try {
      created = await this.scoped.create(RuleCategory, {
        tenantId: 1,
        categoryCode: dto.categoryCode,
        name: dto.name.trim(),
        status: 'active',
      } as never);
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new RuleCategoryCodeExistsError({ cause: error });
      }
      throw error;
    }

    this.audit.annotate({ targetId: created.id, detail: { categoryCode: created.categoryCode } });
    return toRuleCategoryDto(created);
  }

  /** T-106 — `PATCH /rule-categories/:id`. `categoryCode` is immutable — never accepted here. */
  async updateCategory(
    actor: AuthenticatedUser,
    id: number,
    dto: UpdateRuleCategoryDto,
  ): Promise<RuleCategoryDto> {
    assertRole(actor, 'super_admin');

    await this.scoped.findByPkOrFail(RuleCategory, id);
    const changes: Partial<RuleCategory> = {};
    if (dto.name !== undefined) changes.name = dto.name.trim();
    if (dto.status !== undefined) changes.status = dto.status;

    if (Object.keys(changes).length > 0) {
      await this.scoped.update(RuleCategory, changes, { where: { id } });
    }

    const after = await this.scoped.findByPkOrFail(RuleCategory, id);
    this.audit.annotate({ targetId: id, detail: { changes } });
    return toRuleCategoryDto(after);
  }

  /**
   * T-106 — `POST /rule-sub-categories`. `super_admin` only. `categoryId` must reference a
   * real, existing category — `findByPkOrFail` surfaces a 404 rather than a raw FK violation
   * if it doesn't.
   */
  async createSubCategory(
    actor: AuthenticatedUser,
    dto: CreateRuleSubCategoryDto,
  ): Promise<RuleSubCategoryDto> {
    assertRole(actor, 'super_admin');

    await this.scoped.findByPkOrFail(RuleCategory, dto.categoryId);

    const duplicateCount = await this.scoped.count(RuleSubCategory, {
      where: { categoryId: dto.categoryId, subCategoryCode: dto.subCategoryCode },
    });
    if (duplicateCount > 0) throw new RuleSubCategoryCodeExistsError();

    let created: RuleSubCategory;
    try {
      created = await this.scoped.create(RuleSubCategory, {
        categoryId: dto.categoryId,
        subCategoryCode: dto.subCategoryCode,
        name: dto.name.trim(),
        status: 'active',
      } as never);
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new RuleSubCategoryCodeExistsError({ cause: error });
      }
      throw error;
    }

    this.audit.annotate({
      targetId: created.id,
      detail: { subCategoryCode: created.subCategoryCode },
    });
    return toRuleSubCategoryDto(created);
  }

  /** T-106 — `PATCH /rule-sub-categories/:id`. `subCategoryCode`/`categoryId` are immutable —
   * neither is accepted here. */
  async updateSubCategory(
    actor: AuthenticatedUser,
    id: number,
    dto: UpdateRuleSubCategoryDto,
  ): Promise<RuleSubCategoryDto> {
    assertRole(actor, 'super_admin');

    await this.scoped.findByPkOrFail(RuleSubCategory, id);
    const changes: Partial<RuleSubCategory> = {};
    if (dto.name !== undefined) changes.name = dto.name.trim();
    if (dto.status !== undefined) changes.status = dto.status;

    if (Object.keys(changes).length > 0) {
      await this.scoped.update(RuleSubCategory, changes, { where: { id } });
    }

    const after = await this.scoped.findByPkOrFail(RuleSubCategory, id);
    this.audit.annotate({ targetId: id, detail: { changes } });
    return toRuleSubCategoryDto(after);
  }

  // --- private helpers -----------------------------------------------------------------------

  /**
   * T-111 — `GET /rules?categoryId=`'s rollup: every `rule_sub_categories.id` under `categoryId`
   * (`RuleSubCategory.categoryId` is the direct FK — implementation note 2). `[]` for a bogus or
   * empty category, which `Op.in: []` then correctly turns into "no rows match", the same "empty
   * result, not an error" shape `list()`'s other reference-data filters already have — never a
   * 404, since `categoryId` is a narrowing filter, not a resource lookup.
   */
  private async resolveSubCategoryIds(categoryId: number): Promise<number[]> {
    const rows = await this.scoped.listAll(RuleSubCategory, {
      where: { categoryId },
      attributes: ['id'],
    });
    return rows.map((row) => row.id);
  }

  /**
   * T-122 — every `valueSource` in `parameters` must name a provider code that exists in the
   * matching registry (`13-REWARD-MASTER-VALUE-SOURCES.md` §3). Unknown code → 400
   * ({@link UnknownFieldValueSourceProviderError}).
   *
   * ### `planned` is deliberately accepted
   *
   * There is no `status` filter in either query below, and that is the whole point rather than an
   * omission: §3 states that a rule field *may* be authored against a `planned` provider, so this
   * work is not blocked waiting on another team to confirm an endpoint. T-123 declines the runtime
   * lookup for a `planned` provider and T-125 renders that state — refusing the *authoring* write
   * here would re-introduce exactly the dependency §3 exists to remove. Only a code that no row
   * carries at all is an error. (`inactive` is likewise accepted; a provider retired after a rule
   * was authored against it must not make that rule uneditable — the same "existence, not
   * usability" line, and the runtime lookup is where usability is judged.)
   *
   * ### Why the schema is re-parsed here instead of trusting the DTO
   *
   * `@IsRuleParameters()` has already run this exact schema at the controller boundary, so this
   * parse cannot fail for an HTTP caller. It is repeated for the same reason `assertRole` is
   * repeated in every mutating method of this file (layer 2 of the header): a future in-process
   * caller that reaches `create`/`update` without the `ValidationPipe` must not thereby skip the
   * provider check, which is what reading `fields` out of a loosely-typed `Record` with a cast
   * would have allowed. It also gives this method a typed `fields` array without an `as` cast.
   *
   * One query per registry at most — the distinct codes are collected across all fields first, so
   * a rule with twenty sourced fields still costs two reads, not twenty. Membership is decided by
   * comparing the returned codes against the requested set rather than by trusting the `where` to
   * have filtered, so a code is only ever treated as known because a row came back carrying it.
   */
  private async assertValueSourceProvidersExist(
    parameters: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (parameters === undefined) return;

    const parsed = ruleParametersSchema.safeParse(parameters);
    if (!parsed.success) {
      throw new ValidationFailedError([{ field: 'parameters', code: 'IS_RULE_PARAMETERS' }], {
        logMessage: 'rule parameters reached RulesService without passing the shared meta-schema',
      });
    }

    const contextRefs = new Map<string, string>();
    const apiRefs = new Map<string, string>();
    for (const field of parsed.data.fields) {
      const source = field.valueSource;
      if (source === undefined) continue;
      // First field to reference a given code owns the error message for it — the caller fixes
      // one field at a time regardless, and a code is far more often shared than mistyped twice.
      if (source.kind === 'CONTEXT_LOOKUP') {
        if (!contextRefs.has(source.contextProvider)) {
          contextRefs.set(source.contextProvider, field.key);
        }
      } else if (!apiRefs.has(source.apiProvider)) {
        apiRefs.set(source.apiProvider, field.key);
      }
    }

    // The two reads are spelled out per registry rather than folded into one model-generic
    // helper: `ScopedRepository.listAll`'s `where` is typed against the concrete model's
    // attributes, and a helper generic over `ModelStatic<M>` cannot express "…and `M` has a
    // `providerCode` column" in a way that Sequelize's `WhereOptions<Attributes<M>>` accepts —
    // it typechecks only with a cast. Four duplicated lines are cheaper than a cast here, and the
    // decision they share (which codes are missing) is factored into `assertAllProvidersFound`.
    if (contextRefs.size > 0) {
      const rows = await this.scoped.listAll(FieldContextProvider, {
        where: { providerCode: [...contextRefs.keys()] },
        attributes: ['providerCode'],
      });
      assertAllProvidersFound(
        contextRefs,
        rows.map((row) => row.providerCode),
      );
    }

    if (apiRefs.size > 0) {
      const rows = await this.scoped.listAll(FieldApiLookupProvider, {
        where: { providerCode: [...apiRefs.keys()] },
        attributes: ['providerCode'],
      });
      assertAllProvidersFound(
        apiRefs,
        rows.map((row) => row.providerCode),
      );
    }
  }

  private async findGlobalRuleOrFail(id: number): Promise<RuleWithCategory> {
    const rule = await this.scoped.findByPkOrFail(RuleMaster, id, {
      where: { tenantId: null },
      ...WITH_CATEGORY,
    });
    return rule as RuleWithCategory;
  }

  /** T-114 — single-rule convenience wrapper over {@link resolveInputFieldKeysByRule}, for the
   * single-row read/write paths (`getById`, `create`, `update`) that don't already have a
   * batch of rule ids on hand the way `list` does. */
  private async withParameterRoles(dto: RuleDto): Promise<RuleDto> {
    const keys = await this.resolveInputFieldKeys(dto.id);
    return { ...dto, parameters: withParameterFieldRoles(dto.parameters, keys) };
  }

  private async resolveInputFieldKeys(ruleId: number): Promise<ReadonlySet<string>> {
    const keysByRule = await this.resolveInputFieldKeysByRule([ruleId]);
    return keysByRule.get(ruleId) ?? new Set();
  }

  /**
   * T-114 — for each `ruleId`, the `resolver_input_field_keys` (`T114_001`) of the resolver its
   * **latest** version (any status — highest `versionNo`; `T105_002`'s own seeds are `draft`,
   * not `published`) is wired to. `[]` when the rule has no version at all, or that version's
   * `resolverId` is `null` (T-103's "not yet wired" reading) — every field on such a rule is
   * `compare_value` (T-114 TC-4), because there is nothing to look up yet.
   *
   * One query for the relevant `rule_versions` rows plus one for the distinct `rule_resolvers`
   * rows they reference, regardless of how many rule ids are asked for — not one round trip per
   * row, which is what `list()` calling this per-row would otherwise cost on a full page.
   *
   * Ordering by `versionNo DESC` and keeping the first row seen per `ruleId` is correct even
   * though the single query mixes rows from every requested rule: `uq_rv_rule_version` means two
   * rows sharing a `ruleId` never share a `versionNo`, so for any fixed `ruleId` its own rows
   * still appear in descending order relative to each other, however ties with *other* rules'
   * rows (which can share a `versionNo` value) are broken.
   */
  private async resolveInputFieldKeysByRule(
    ruleIds: readonly number[],
  ): Promise<ReadonlyMap<number, ReadonlySet<string>>> {
    if (ruleIds.length === 0) return new Map();

    const versions = await this.scoped.listAll(RuleVersion, {
      where: { ruleId: ruleIds },
      order: [['versionNo', 'DESC']],
    });
    const latestByRule = new Map<number, RuleVersion>();
    for (const version of versions) {
      if (!latestByRule.has(version.ruleId)) latestByRule.set(version.ruleId, version);
    }

    const resolverIds = [
      ...new Set(
        [...latestByRule.values()]
          .map((version) => version.resolverId)
          .filter((id): id is number => id !== null),
      ),
    ];
    const resolvers =
      resolverIds.length === 0
        ? []
        : await this.scoped.listAll(RuleResolver, { where: { id: resolverIds } });
    const resolverById = new Map(resolvers.map((resolver) => [resolver.id, resolver]));

    const result = new Map<number, ReadonlySet<string>>();
    for (const ruleId of ruleIds) {
      const version = latestByRule.get(ruleId);
      const resolver =
        version?.resolverId != null ? resolverById.get(version.resolverId) : undefined;
      result.set(ruleId, new Set(resolver?.resolverInputFieldKeys ?? []));
    }
    return result;
  }

  /** Synchronous sibling of {@link withParameterRoles} for `list()`, which already has every
   * row's keys batched via {@link resolveInputFieldKeysByRule} before this is called. */
  private annotateRoles(
    dto: RuleDto,
    keysByRule: ReadonlyMap<number, ReadonlySet<string>>,
  ): RuleDto {
    return {
      ...dto,
      parameters: withParameterFieldRoles(dto.parameters, keysByRule.get(dto.id) ?? new Set()),
    };
  }

  /**
   * `rule_master.created_by` and `rule_country_assignments.assigned_by` both carry a real,
   * live foreign key to `reward_config.admin_users(id)` — confirmed against the live schema's
   * `fk_rm_created_by`/`fk_rca_admin` constraints, not assumed from the T-SQL-derived design
   * doc alone. `admin_users` and `reward_portal.portal_users` are disjoint id spaces
   * (00-ARCHITECTURE.md §5.2 gap G1), so `actor.userId` written directly into either column
   * fails that FK for every actor that has no counterpart row — which, for `super_admin`
   * specifically, is every account T-004's bootstrap CLI creates today. This resolves the
   * *sanctioned* bridge instead — `portal_users.admin_user_id` (01-DATABASE.md §2.1), the same
   * link `audit.service.ts#recordDomainEvent` already documents and uses for
   * `campaign_audit_trail.performed_by` — and returns `null`, which both columns accept, when
   * no bridge exists. This is a live, disclosed platform gap (the same one `audit.service.ts`'s
   * own header names), not a bug this task can close: nothing shipped so far populates
   * `admin_user_id` for a `super_admin` account.
   */
  private async resolveAdminUserId(actor: AuthenticatedUser): Promise<number | null> {
    const self = await this.scoped.findByPkOrFail(PortalUser, actor.userId);
    return self.adminUserId;
  }
}

// --- module-private helpers --------------------------------------------------------------------

function parseSort(sort: string | undefined): [RuleSortField, 'asc' | 'desc'] {
  if (sort === undefined) return ['name', 'asc'];
  const [field, direction] = sort.split(':') as [RuleSortField, 'asc' | 'desc'];
  return [field, direction];
}

/**
 * T-122 — the shared decision behind both registry reads in
 * {@link RulesService.assertValueSourceProvidersExist}: every referenced code must appear among
 * the codes actually returned.
 *
 * Membership is decided from `foundCodes` — what the database gave back — rather than from the
 * fact that a query ran, so a `where` clause that failed to filter, or a repository double that
 * ignores it, can never make an unknown code look known.
 */
function assertAllProvidersFound(
  refs: ReadonlyMap<string, string>,
  foundCodes: readonly string[],
): void {
  const found = new Set(foundCodes);
  for (const [providerCode, fieldKey] of refs) {
    if (!found.has(providerCode)) {
      throw new UnknownFieldValueSourceProviderError(fieldKey, providerCode);
    }
  }
}

/** Only the columns the caller actually supplied — `ruleCode` is immutable, never here. */
function collectRuleChanges(dto: UpdateRuleDto): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  if (dto.name !== undefined) changes['name'] = dto.name.trim();
  if (dto.subCategoryId !== undefined) changes['subCategoryId'] = dto.subCategoryId;
  if (dto.expression !== undefined) changes['expression'] = dto.expression;
  if (dto.parameters !== undefined) changes['parameters'] = dto.parameters;
  if (dto.status !== undefined) changes['status'] = dto.status;
  return changes;
}

/** The plain-object snapshot `AuditService.diffFields` compares — the model's JSON getters
 * (`parameters`) already return a comparable value, not the raw `text` column. */
function fieldSnapshot(rule: RuleMaster): Record<string, unknown> {
  return {
    name: rule.name,
    subCategoryId: rule.subCategoryId,
    expression: rule.expression,
    parameters: rule.parameters,
    status: rule.status,
  };
}
