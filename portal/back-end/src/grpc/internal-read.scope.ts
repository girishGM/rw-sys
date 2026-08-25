/**
 * T-047 — how a call that has **no portal user** performs a scoped, read-only database read.
 *
 * ### The problem
 *
 * R2 says every query goes through `ScopedRepository`, and `ScopedRepository` refuses to run
 * without a `RequestScope` — deliberately, because *"a missing scope context is a hard 500, never a
 * silent full-table query"* (T-013 implementation note 2). But the caller here is a peer service
 * holding a client certificate, not a portal user holding a JWT, so the two-link chain
 * `JwtAuthGuard → TenancyScopeInterceptor` that normally establishes that context does not exist.
 *
 * ### The answer, and why it is not a hole in R3
 *
 * A scope is established from the **grant**, never from the request. The chain is:
 *
 * ```
 * TLS handshake (CA-validated client cert)
 *   → SAN                          mtls.guard.ts
 *   → grpc_service_grants row      service-scope.guard.ts   ← the allowlist
 *   → tenant_id of that grant      ServiceScopeGuard.grantFor(...)
 *   → RequestScope                 this file
 *   → WHERE clause                 ScopedRepository
 * ```
 *
 * The `tenant_id` in the request body is **checked against** the grant before it is used, and a
 * mismatch is `PERMISSION_DENIED` (TC-11). So the value that reaches the WHERE clause is one the
 * portal's own grant table authorised, which is precisely what R3 asks for: *"`tenantId` … comes
 * from the verified JWT only"* is a statement about not trusting the client, and here the verified
 * artefact is a certificate plus a grant row rather than a JWT.
 *
 * ### Two scopes, and why the second one exists
 *
 * `runAsTenant` uses role `tenant_admin`, whose strategies key every campaign-owned table on
 * `tenant_id` — the shape this read wants. But five tables (`rule_master`, `rule_versions`,
 * `reward_systems`, `reward_policies`, `reward_versions`) are scoped for that role by **current
 * country assignment**, and a pinned version must resolve *for the life of the record*
 * (implementation note 7: *"retirement stops new bindings, never hides history"*). A rule
 * un-assigned from a country last month would otherwise make a running campaign's configuration
 * unbuildable, and §10 says the only alternative to a complete config is an error — so the portal
 * would start refusing to serve live campaigns because of an authoring action that, by design,
 * does not affect them.
 *
 * `runAsDefinitionReader` therefore reads those five tables under `super_admin`, whose compiled
 * clause is empty. That is not a tenancy relaxation: those tables are **global, Super-Admin-owned
 * configuration** with no tenant column that means anything here (`rule_master.tenant_id` is NULL
 * for every globally-authored rule), and the rows read are only ever the ones a *pin already
 * inside this tenant's own campaign* names. Nothing is enumerated: every read is `id IN (…)` over
 * ids that came out of a tenant-scoped query one step earlier.
 *
 * ### Read-only, enforced by Postgres
 *
 * Implementation note 1 asks for a DB role granted `SELECT` only. `sequelize-typescript` binds a
 * model class to exactly one connection, so a second connection for this path would require a
 * duplicate model registry and would put R2's single door back to two. Instead every internal read
 * runs inside a transaction marked `SET TRANSACTION READ ONLY`: any INSERT/UPDATE/DELETE issued on
 * that connection inside it — including one a future bug introduces — is refused **by the database**
 * (`ERROR: cannot execute INSERT in a read-only transaction`), which is the property the separate
 * role was for (TC-14). It also gives implementation note 4's other requirement for free: one
 * transaction, so the snapshot is internally consistent rather than a set of reads that raced a
 * concurrent edit.
 *
 * A `SELECT`-only database role remains the right belt-and-braces control at deployment time and is
 * recommended to the runtime team in the completion report; it is a `GRANT`, not application code.
 */
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ScopeContext, type RequestScope } from '@/common/scope/scope-context';

/** The user id an internal read carries. There is no portal user; `0` is not a valid
 * `portal_users.id` (the column is `generated always as identity`, so ids start at 1), which
 * makes an accidental "own rows only" match impossible rather than merely unlikely. */
const NO_PORTAL_USER = 0;

/** The scope an internal read uses for campaign-owned tables. */
export function internalTenantScope(tenantId: number, countryId: number | null): RequestScope {
  return {
    userId: NO_PORTAL_USER,
    role: 'tenant_admin',
    countryId,
    tenantId,
    merchantId: null,
  };
}

/** The scope the five global definition tables are read under. See this file's header. */
export function internalDefinitionScope(): RequestScope {
  return {
    userId: NO_PORTAL_USER,
    role: 'super_admin',
    countryId: null,
    tenantId: null,
    merchantId: null,
  };
}

/** Runs `fn` with the tenant scope of `tenantId` established. */
export function runAsTenant<T>(
  tenantId: number,
  countryId: number | null,
  fn: () => Promise<T>,
): Promise<T> {
  return ScopeContext.run(internalTenantScope(tenantId, countryId), fn);
}

/** Runs `fn` with the global definition-reader scope established. Keep the body of a call to this
 * as small as the pinned-version lookup it exists for. */
export function runAsDefinitionReader<T>(fn: () => Promise<T>): Promise<T> {
  return ScopeContext.run(internalDefinitionScope(), fn);
}

/**
 * Runs `fn` with an unrestricted scope, for an identity whose **own grant is global**
 * (`grpc_service_grants.tenant_id IS NULL`, meaning "every tenant" — see `T047_001`'s header).
 *
 * Same scope object as {@link runAsDefinitionReader} and a different name on purpose: the two are
 * authorised by completely different facts, and a reader of the call site needs to know which one
 * applies. This one is only ever legitimate after `ServiceScopeGuard` has found a global grant, and
 * its single caller — `budget-breach.controller.ts`, which must discover a campaign's tenant before
 * it can scope anything to it — says so at the call site.
 */
export function runAsGlobalGrantHolder<T>(fn: () => Promise<T>): Promise<T> {
  return ScopeContext.run(internalDefinitionScope(), fn);
}

/**
 * Opens one **read-only** transaction and runs `fn` inside it.
 *
 * `SET TRANSACTION READ ONLY` is issued as the transaction's first statement, which is the only
 * point Postgres accepts it.
 */
export async function runReadOnly<T>(
  sequelize: Sequelize,
  fn: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET TRANSACTION READ ONLY', { type: QueryTypes.RAW, transaction });
    return fn(transaction);
  });
}
