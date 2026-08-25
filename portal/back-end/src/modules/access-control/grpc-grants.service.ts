/**
 * T-047 §4d — `reward_portal.grpc_service_grants`, read by the gRPC port on every call and
 * administered by `super_admin` through `/admin/grpc-grants`.
 *
 * ### Two consumers, one table, deliberately one service
 *
 *  - **The internal gRPC/mTLS surface** resolves a certificate SAN to the tenants and sections
 *    that identity may read (§4c). This is an *authorisation boundary*, not a preference.
 *  - **The admin REST surface** (§4d) creates, narrows and revokes those grants, audited.
 *
 * Keeping both behind one class is what makes "an admin narrowed the grant, and the next gRPC
 * call respected it" true by construction (TC-43): there is exactly one place that knows what a
 * grant means, and the gRPC path re-reads it per request rather than caching it.
 *
 * ### Why this uses parameterised SQL rather than `ScopedRepository`
 *
 * The same reasoning `credential.repository.ts` (T-010) records for `portal_user_credentials`,
 * and it is not a loophole in R2 — it is the case R2's mechanism does not fit:
 *
 *  1. **There is no actor scope to apply on the read path.** The gRPC caller is a peer service
 *     with a client certificate, not a portal user; there is no JWT, so there is no `RequestScope`
 *     and `ScopedRepository` would (correctly) refuse to run at all. Manufacturing a portal scope
 *     to satisfy the machinery would be pretending an actor exists.
 *  2. **The admin path's only actor is `super_admin`**, whose compiled scope clause is empty by
 *     design (`scope-strategy.ts#buildScopeWhere` returns `where: null` for it before the strategy
 *     map is even consulted). A scoped read here would add literally nothing to the SQL.
 *  3. The table is global — a grant is keyed by certificate identity, and its `tenant_id` is the
 *     *subject* of the grant rather than the actor's tenancy.
 *
 * Every statement below binds its values through Sequelize `replacements`; no value is
 * interpolated into SQL text anywhere in this file. The R2 lint rule is untouched: there is no
 * raw model access here either, because this table has no model.
 *
 * ### Revocation is a status flip, never a delete
 *
 * `T047_001` revokes `DELETE` from `reward_app` outright. An access-control row that vanished
 * leaves no trace of who could once read what, which is precisely the question an incident
 * review asks.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { AuditService } from '@/common/audit/audit.service';
import { assertRole } from '@/common/rbac/assert-role';
import { ConflictError, NotFoundError, ValidationFailedError } from '@/common/errors/app-error';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import {
  ALL_SECTIONS,
  ALWAYS_INCLUDED_SECTION,
  GRANT_AUDIT_EVENT,
  GRANT_STATUS,
  SERVICE_IDENTITY_MAX_LENGTH,
  type ConfigSectionName,
} from '@/grpc/grpc.constants';
// The DTOs live under `src/grpc/dto/` rather than beside this file: `modules/access-control/dto/`
// belongs to T-033, and T-047's file scope carves out exactly two files in this directory. Same
// reasoning as `actor-ref.ts` living in `modules/campaigns/` rather than in `common/` (R9).
import type { CreateGrpcGrantDto, UpdateGrpcGrantDto } from '@/grpc/dto/grpc-grant.dto';

/** One row of `grpc_service_grants`, as the rest of the system sees it. */
export interface GrpcServiceGrant {
  readonly id: number;
  readonly serviceIdentity: string;
  /** `null` means **every tenant** — see `T047_001`'s header on `tenant_key`. */
  readonly tenantId: number | null;
  readonly allowedSections: readonly ConfigSectionName[];
  readonly status: string;
  readonly createdBy: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface GrantRow {
  id: number;
  service_identity: string;
  tenant_id: number | null;
  allowed_sections: unknown;
  status: string;
  created_by: number;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  'id, service_identity, tenant_id, allowed_sections, status, created_by, created_at, updated_at';

@Injectable()
export class GrpcGrantsService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly audit: AuditService,
  ) {}

  // --- the gRPC read path ----------------------------------------------------------------------

  /**
   * Every **active** grant held by `serviceIdentity`.
   *
   * Read per request rather than cached, exactly as §4d states: *"the gRPC server reads grants
   * per-request, since grant checks are not on the request-volume hot path the way RBAC is"*. That
   * is what makes TC-43 hold — a narrowed grant applies on the caller's next call, with no cache
   * to invalidate and no window in which the old grant is still honoured.
   */
  async activeGrantsFor(serviceIdentity: string): Promise<readonly GrpcServiceGrant[]> {
    if (serviceIdentity.trim() === '') return [];
    const rows = await this.sequelize.query<GrantRow>(
      `SELECT ${COLUMNS} FROM reward_portal.grpc_service_grants
        WHERE service_identity = :identity AND status = :status
        ORDER BY tenant_id NULLS LAST, id`,
      {
        type: QueryTypes.SELECT,
        replacements: { identity: serviceIdentity, status: GRANT_STATUS.ACTIVE },
      },
    );
    return rows.map(toGrant);
  }

  // --- the admin surface (§4d) -----------------------------------------------------------------

  /** `GET /admin/grpc-grants`. Every grant, revoked ones included — a revoked grant is part of
   * the history an operator is looking at. */
  async list(actor: AuthenticatedUser): Promise<readonly GrpcServiceGrant[]> {
    assertRole(actor, 'super_admin');
    const rows = await this.sequelize.query<GrantRow>(
      `SELECT ${COLUMNS} FROM reward_portal.grpc_service_grants ORDER BY service_identity, id`,
      { type: QueryTypes.SELECT },
    );
    return rows.map(toGrant);
  }

  /** `GET /admin/grpc-grants/:id`. */
  async getById(actor: AuthenticatedUser, id: number): Promise<GrpcServiceGrant> {
    assertRole(actor, 'super_admin');
    const grant = await this.load(id);
    if (grant === null) throw new NotFoundError({ logMessage: `grpc grant ${id} not found` });
    return grant;
  }

  /**
   * `POST /admin/grpc-grants`.
   *
   * `created_by` is the actor's own portal-user id and is **not** taken from the body — §4c added
   * the column *"so grants are attributable"*, and a caller-supplied attribution is not one.
   */
  async create(actor: AuthenticatedUser, dto: CreateGrpcGrantDto): Promise<GrpcServiceGrant> {
    assertRole(actor, 'super_admin');
    const identity = normaliseIdentity(dto.serviceIdentity);
    const sections = normaliseSections(dto.allowedSections);
    const tenantId = dto.tenantId ?? null;

    const created = await this.sequelize.transaction(async (transaction) => {
      const clash = await this.sequelize.query<{ id: number }>(
        `SELECT id FROM reward_portal.grpc_service_grants
          WHERE service_identity = :identity AND coalesce(tenant_id, -1) = coalesce(:tenantId, -1)`,
        {
          type: QueryTypes.SELECT,
          replacements: { identity, tenantId },
          transaction,
        },
      );
      // `uq_gsg` would refuse this anyway (TC-36) — the pre-check exists to answer with a 409 and
      // a legible message rather than a driver-level constraint error.
      if (clash.length > 0) {
        throw new ConflictError('GRPC_GRANT_EXISTS', {
          logMessage: `grant already exists for ${identity} / tenant ${String(tenantId)}`,
        });
      }

      const [row] = await this.sequelize.query<GrantRow>(
        `INSERT INTO reward_portal.grpc_service_grants
           (service_identity, tenant_id, allowed_sections, status, created_by)
         VALUES (:identity, :tenantId, CAST(:sections AS jsonb), :status, :createdBy)
         RETURNING ${COLUMNS}`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            identity,
            tenantId,
            sections: JSON.stringify(sections),
            status: GRANT_STATUS.ACTIVE,
            createdBy: actor.userId,
          },
          transaction,
        },
      );
      return toGrant(row);
    });

    await this.audit.recordPortalEvent({
      eventType: GRANT_AUDIT_EVENT.CREATED,
      actorId: actor.userId,
      actorRole: actor.role,
      targetType: 'grpc_service_grant',
      targetId: created.id,
      tenantId: created.tenantId,
      detail: {
        serviceIdentity: created.serviceIdentity,
        tenantId: created.tenantId,
        allowedSections: created.allowedSections,
      },
    });
    return created;
  }

  /**
   * `PATCH /admin/grpc-grants/:id` — narrow the sections, or revoke.
   *
   * `service_identity` and `tenant_id` are **not** patchable. Re-pointing an existing grant at a
   * different certificate would silently transfer an authorisation to another service while
   * keeping the original row's audit history, which is exactly the manoeuvre an audit trail
   * exists to make visible. Revoke and create instead: two audited events, both attributable.
   */
  async update(
    actor: AuthenticatedUser,
    id: number,
    dto: UpdateGrpcGrantDto,
  ): Promise<GrpcServiceGrant> {
    assertRole(actor, 'super_admin');
    const before = await this.load(id);
    if (before === null) throw new NotFoundError({ logMessage: `grpc grant ${id} not found` });

    const sections =
      dto.allowedSections === undefined
        ? before.allowedSections
        : normaliseSections(dto.allowedSections);
    const status = dto.status ?? before.status;

    const [row] = await this.sequelize.query<GrantRow>(
      `UPDATE reward_portal.grpc_service_grants
          SET allowed_sections = CAST(:sections AS jsonb), status = :status, updated_at = now()
        WHERE id = :id
      RETURNING ${COLUMNS}`,
      {
        type: QueryTypes.SELECT,
        replacements: { id, sections: JSON.stringify(sections), status },
      },
    );
    const after = toGrant(row);

    await this.audit.recordPortalEvent({
      eventType:
        status === GRANT_STATUS.REVOKED && before.status !== GRANT_STATUS.REVOKED
          ? GRANT_AUDIT_EVENT.REVOKED
          : GRANT_AUDIT_EVENT.UPDATED,
      actorId: actor.userId,
      actorRole: actor.role,
      targetType: 'grpc_service_grant',
      targetId: after.id,
      tenantId: after.tenantId,
      // The delta, not just the new state — §4d asks for "the section/tenant delta".
      detail: {
        serviceIdentity: after.serviceIdentity,
        tenantId: after.tenantId,
        sectionsBefore: before.allowedSections,
        sectionsAfter: after.allowedSections,
        statusBefore: before.status,
        statusAfter: after.status,
      },
    });
    return after;
  }

  private async load(id: number, transaction?: Transaction): Promise<GrpcServiceGrant | null> {
    const rows = await this.sequelize.query<GrantRow>(
      `SELECT ${COLUMNS} FROM reward_portal.grpc_service_grants WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id }, transaction },
    );
    return rows.length === 0 ? null : toGrant(rows[0]);
  }
}

// --- module-private helpers ---------------------------------------------------------------------

function toGrant(row: GrantRow): GrpcServiceGrant {
  return {
    id: row.id,
    serviceIdentity: row.service_identity,
    tenantId: row.tenant_id,
    allowedSections: readSections(row.allowed_sections),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The stored `jsonb` array, filtered to names this build actually knows.
 *
 * Fail-*closed* on an unknown name: a section this server cannot serve is dropped rather than
 * carried around as a string nobody checks. `T047_001`'s header explains why the enum is not a
 * CHECK constraint — a stale constraint on an authorisation table makes a legitimate new section
 * ungrantable, which is the worse failure.
 */
function readSections(raw: unknown): readonly ConfigSectionName[] {
  const array = Array.isArray(raw) ? raw : [];
  const known = array.filter((entry): entry is ConfigSectionName =>
    ALL_SECTIONS.includes(entry as ConfigSectionName),
  );
  return [...new Set(known)];
}

function normaliseIdentity(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > SERVICE_IDENTITY_MAX_LENGTH) {
    throw new ValidationFailedError([{ field: 'serviceIdentity', code: 'INVALID_LENGTH' }]);
  }
  return trimmed;
}

/**
 * The requested sections, de-duplicated, with `BASIC` always present.
 *
 * §4c: *"`BASIC` is always included. A configuration with no campaign header is not
 * interpretable."* Storing it explicitly means the grant a `super_admin` reads back says exactly
 * what the server will do, rather than relying on a rule applied invisibly at request time.
 */
function normaliseSections(requested: readonly string[]): readonly ConfigSectionName[] {
  const unknown = requested.filter((entry) => !ALL_SECTIONS.includes(entry as ConfigSectionName));
  if (unknown.length > 0) {
    throw new ValidationFailedError(
      unknown.map(() => ({ field: 'allowedSections', code: 'UNKNOWN_SECTION' })),
    );
  }
  const set = new Set<ConfigSectionName>(requested as ConfigSectionName[]);
  set.add(ALWAYS_INCLUDED_SECTION);
  return ALL_SECTIONS.filter((section) => set.has(section));
}
