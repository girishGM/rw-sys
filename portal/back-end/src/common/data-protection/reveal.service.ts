/**
 * T-017 — the reveal path (07-DATA-PROTECTION.md §8, implementation note 7).
 *
 * > *"Reveal endpoint `GET /reveal/:policyKey/:recordId`: role-checked, rate-limited
 * > 30/hour/user, writes `portal_audit_log` `pii_revealed` with actor, field and record —
 * > **never the value** — and returns one field. Unmasking is an event worth recording."*
 *
 * ---
 *
 * ## Order of checks, and why it is this order
 *
 * ```
 *   1. engine enabled?          → 403   (config, cheapest, no I/O)
 *   2. policy exists & is reveal_on_demand & lists the caller's role?
 *                                → 403 + audit denial
 *   3. rate limit                → 429   (before any database read)
 *   4. scoped record read        → 404   (ScopedRepository; out-of-tenant is indistinguishable)
 *   5. audit 'pii_revealed'      → written BEFORE the value is returned
 *   6. return the single field
 * ```
 *
 * **Authorisation before rate limiting**, deliberately, against the usual advice. The usual
 * advice — shed load before doing work — applies to endpoints an anonymous attacker can reach;
 * this one is behind the full guard chain and the work in step 2 is a map lookup. Ordering it
 * this way means a caller who is not permitted to reveal *never consumes their own quota*, so an
 * attacker cannot exhaust a legitimate support agent's 30/hour by making requests as them. The
 * denial is audited either way, which is the control that actually matters here.
 *
 * **The audit row is written before the value is returned** (step 5, and it `await`s). If the
 * insert fails, `AuditService` logs the event at `error` and the request proceeds — that is
 * T-014's documented contract and it is right for ordinary events. What must not happen is the
 * *reverse* order, where the value is serialised first and the audit write is a fire-and-forget
 * afterthought: a disclosure that is not recorded is exactly the thing §8 exists to prevent.
 *
 * ## Why the record read goes through `ScopedRepository`
 *
 * This endpoint takes an arbitrary table and an arbitrary primary key from the URL. Without
 * scoping, a `tenant_admin` could reveal any other tenant's merchant contact email by guessing an
 * id — a cross-tenant read through the one endpoint whose whole purpose is disclosing PII. R2 and
 * 02-SECURITY.md §5.1 both apply at full strength, so the read is
 * `ScopedRepository.findByPkOrFail`, which applies the caller's scope in the `WHERE` clause and
 * answers **404** for both "no such row" and "not yours" (R6).
 *
 * A policy key naming a table that `scope-strategy.ts` does not register throws
 * `UnscopedModelError` from T-013's fail-closed map. That surfaces as a 500, and correctly so: it
 * means somebody added a `reveal_on_demand` policy for a table nobody has decided the tenancy
 * rules for, and guessing them here is precisely what T-013's map exists to prevent.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Model, ModelStatic } from 'sequelize';
import { AuditService } from '@/common/audit/audit.service';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import { RateLimitedHttpException } from '@/common/security/security.exceptions';
import { THROTTLE_STORE, type ThrottleStore } from '@/common/security/throttle.store';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { scopedModels } from '@/common/scope/scope-strategy';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { DATA_PROTECTION_CONFIG, type DataProtectionConfig } from './data-protection.config';
import { PII_REVEAL_DENIED_EVENT, PII_REVEALED_EVENT } from './data-protection.constants';
import { attributeForColumn, qualifiedTableName } from './model-encryption.hooks';
import { PolicyCacheService } from './policy-cache.service';
import { splitPolicyKey } from './policy.service';

/** One hour, in milliseconds — the reveal counter's window (§8: "30/hour/user"). */
export const REVEAL_WINDOW_MS = 60 * 60 * 1000;

/** What the endpoint returns. One field, one record, nothing else. */
export interface RevealResult {
  readonly policyKey: string;
  readonly recordId: string;
  /** The plaintext. This is the only place in the application that deliberately emits one. */
  readonly value: unknown;
}

@Injectable()
export class RevealService {
  private readonly logger = new Logger(RevealService.name);

  /**
   * Lazily built, because `scopedModels()` is a module-level array that is complete only once
   * every model file has been evaluated — and building this at construction time would couple
   * the map to Nest's provider instantiation order for no benefit.
   */
  private modelsByTable: Map<string, ModelStatic<Model>> | null = null;

  constructor(
    private readonly policies: PolicyCacheService,
    private readonly scoped: ScopedRepository,
    private readonly audit: AuditService,
    @Inject(THROTTLE_STORE) private readonly throttle: ThrottleStore,
    @Inject(DATA_PROTECTION_CONFIG) private readonly config: DataProtectionConfig,
    // `@Optional()` for the reason `policy-cache.service.ts` and `RateLimitGuard` both give: a
    // defaulted constructor parameter is still a parameter to `design:paramtypes`, and without
    // this Nest refuses to build the module looking for a provider for `Function`.
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  async reveal(
    actor: AuthenticatedUser,
    policyKey: string,
    recordId: string,
  ): Promise<RevealResult> {
    if (!this.config.enabled || !this.config.reveal.enabled) {
      throw new PermissionDeniedHttpException();
    }

    this.authorise(actor, policyKey);
    await this.charge(actor);

    const { container: table, leaf: column } = splitPolicyKey(policyKey);
    const model = this.modelFor(table);
    if (model === null) {
      // A policy row for a table this build does not model. 403 rather than 500 or 404: it is a
      // configuration gap, not a caller error, and the caller learns nothing either way.
      this.logger.error(
        `Policy '${policyKey}' is reveal_on_demand but no Sequelize model maps to table ` +
          `'${table}'. The field cannot be revealed until a model exists.`,
      );
      throw new PermissionDeniedHttpException();
    }

    const attribute = attributeForColumn(model, column);
    if (attribute === null) {
      this.logger.error(
        `Policy '${policyKey}' names column '${column}', which ${model.name} does not expose.`,
      );
      throw new PermissionDeniedHttpException();
    }

    // Scoped read — 404 for absent *and* for out-of-tenant, indistinguishably (R6).
    // `attributes` is narrowed to the primary key and the one column: an endpoint that discloses
    // one field should not load, and cannot then accidentally return, the rest of the row.
    const row = await this.scoped.findByPkOrFail(model, recordId, {
      attributes: [model.primaryKeyAttribute, attribute],
    });

    // The value is already plaintext here: if the column is encrypted at rest, the `afterFind`
    // hook decrypted it on the way out of the database.
    const value: unknown = row.getDataValue(attribute as never);

    await this.audit.recordPortalEvent({
      eventType: PII_REVEALED_EVENT,
      actorId: actor.userId,
      actorRole: actor.role,
      targetType: table,
      targetId: recordId,
      countryId: actor.countryId,
      tenantId: actor.tenantId,
      // `detail` carries the field's identity and NOT its value (TC-18). `AuditService` redacts
      // `detail` as well, but the guarantee here is structural: the value is not in the object
      // that is passed, so no redaction bug can leak it.
      detail: { policyKey, column, recordId },
    });

    return { policyKey, recordId, value };
  }

  /**
   * Steps 1–2. Throws 403 and audits the denial (TC-16) for every failure mode, without
   * distinguishing them to the caller.
   *
   * The five failure modes — no such policy, policy disabled, not a column policy, not
   * `reveal_on_demand`, role not listed — are one response on purpose. Telling a caller "that
   * field exists but you may not see it" versus "no such field" maps the policy table for them,
   * which is the same existence oracle 02-SECURITY.md §5.1 rejects for records.
   *
   * `scope === 'column'` is checked because this endpoint addresses a **record**. A `dto_field`
   * policy describes a value that exists only in a request or response body — there is no table
   * and no row to fetch it from — so `GET /reveal/dto.CreateUserResponse.temporaryPassword/7`
   * must be refused rather than falling through to a table lookup that cannot succeed.
   */
  private authorise(actor: AuthenticatedUser, policyKey: string): void {
    const policy = this.policies.policyFor(policyKey);
    const allowed =
      policy !== null &&
      policy.enabled &&
      policy.scope === 'column' &&
      policy.uiVisibility === 'reveal_on_demand' &&
      (policy.revealRoles ?? []).includes(actor.role);

    if (!allowed) {
      // Fire-and-forget is not used: the denial record is the evidence that somebody probed, and
      // it is cheap. `recordPortalEvent` never rejects (T-014), so this cannot mask the 403.
      void this.audit.recordPortalEvent({
        eventType: PII_REVEAL_DENIED_EVENT,
        actorId: actor.userId,
        actorRole: actor.role,
        targetType: 'reveal',
        targetId: policyKey,
        countryId: actor.countryId,
        tenantId: actor.tenantId,
        detail: { policyKey, reason: policy === null ? 'no_policy' : 'role_not_permitted' },
      });
      throw new PermissionDeniedHttpException();
    }
  }

  /**
   * Step 3 — 30 reveals per hour per user (TC-17), keyed by the **verified** user id.
   *
   * Keyed per user rather than per IP because the control in §8 is about a *person* harvesting
   * PII (*"a support agent who viewed 400 customer emails in an hour"*), and an IP is neither
   * stable for them nor unique to them.
   *
   * **Fails closed.** If the counter store is unreachable the reveal is refused, unlike the
   * general API rate limit which fails open (AR-11). The asymmetry is deliberate and is the same
   * reasoning AR-11 applies to `/auth/login`: an unmetered login endpoint and an unmetered PII
   * disclosure endpoint are both worth more than the availability of the feature they gate.
   */
  private async charge(actor: AuthenticatedUser): Promise<void> {
    const limit = this.config.reveal.rateLimitPerHour;
    const now = this.now();

    let counter;
    try {
      counter = await this.throttle.consume(
        `reveal:user:${String(actor.userId)}`,
        REVEAL_WINDOW_MS,
        now,
      );
    } catch (error) {
      this.logger.error(
        `Reveal rate-limit counter unavailable (${(error as Error).message}); refusing the ` +
          `reveal. This endpoint fails closed — see reveal.service.ts.`,
      );
      throw new RateLimitedHttpException(Math.ceil(REVEAL_WINDOW_MS / 1000));
    }

    if (counter.count > limit) {
      throw new RateLimitedHttpException(Math.max(1, Math.ceil((counter.resetAt - now) / 1000)));
    }
  }

  /** Schema-qualified table → model, built once from T-013's registered-model list. */
  private modelFor(table: string): ModelStatic<Model> | null {
    if (this.modelsByTable === null) {
      this.modelsByTable = new Map(
        scopedModels().map((model) => [qualifiedTableName(model), model]),
      );
    }
    return this.modelsByTable.get(table) ?? null;
  }
}
