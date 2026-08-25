/**
 * T-017 — reading `reward_portal.data_protection_policies`.
 *
 * A token plus an interface, following the shape `AUDIT_STORE`, `PERMISSION_STORE`,
 * `CREDENTIAL_STORE` and `THROTTLE_STORE` already use in this codebase, and for the same reason:
 * it is what lets `PolicyCacheService` be tested against a store that **fails on demand**, which
 * is the only way to exercise TC-21 ("policy cache made to throw ⇒ fields masked, request not
 * failed open") at all.
 *
 * ### Why raw SQL rather than a Sequelize model
 *
 * Three reasons, in order of weight:
 *
 *  1. **This table is configuration for the ORM's own hooks.** `model-encryption.hooks.ts`
 *     installs `beforeCreate`/`afterFind` on models *from* these rows. Reading the rows through a
 *     model would mean the hook installer depended on a model that is itself a hook target, and a
 *     mistake in that loop is an infinite one at boot.
 *  2. **`ScopedRepository` does not apply and must not appear to.** These rows are global
 *     configuration with no tenancy axis — there is no `tenant_id` to scope by — so registering
 *     the table in `scope-strategy.ts` would mean adding a `unrestricted()` entry to a file
 *     T-013 owns, to describe a table no tenant-facing endpoint reads. R2 bans bypassing
 *     `ScopedRepository` *in a service that serves tenant data*; a boot-time configuration read
 *     is the same category as `PermissionRepository`'s and `AuditRepository`'s raw reads, both
 *     of which T-013/T-014 shipped for this reason.
 *  3. `jsonb` → `string[]` coercion for `reveal_roles` is explicit here, in one place, rather
 *     than dependent on a dialect's JSON handling.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import type {
  AtRest,
  Classification,
  InTransit,
  LogTreatment,
  MaskStrategyName,
  PolicyScope,
  UiVisibility,
} from './data-protection.constants';
import type { DataProtectionPolicy } from './policy.service';

/** DI token for {@link PolicyStore}. */
export const POLICY_STORE = Symbol('POLICY_STORE');

export interface PolicyStore {
  /** Every row, enabled or not — {@link PolicySet} needs the disabled ones for classification. */
  findAllPolicies(): Promise<DataProtectionPolicy[]>;
}

/** The `snake_case` shape Postgres returns. */
interface PolicyRow {
  policy_key: string;
  scope: string;
  classification: string;
  at_rest: string;
  blind_index: boolean;
  in_transit: string;
  log_treatment: string;
  mask_strategy: string | null;
  ui_visibility: string;
  reveal_roles: unknown;
  key_purpose: string | null;
  enabled: boolean;
  note: string | null;
}

@Injectable()
export class PolicyRepository implements PolicyStore {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async findAllPolicies(): Promise<DataProtectionPolicy[]> {
    const rows = await this.sequelize.query<PolicyRow>(
      `SELECT policy_key, scope, classification, at_rest, blind_index, in_transit,
              log_treatment, mask_strategy, ui_visibility, reveal_roles, key_purpose,
              enabled, note
         FROM reward_portal.data_protection_policies
        ORDER BY policy_key`,
      { type: QueryTypes.SELECT },
    );
    return rows.map(toPolicy);
  }
}

/**
 * Row → domain. Exported so the e2e spec can assert the coercion against real Postgres output
 * without going through the injectable.
 *
 * The enum columns are cast rather than parsed: every one of them is covered by a `CHECK`
 * constraint *and* re-validated by `validatePolicy` when the `PolicySet` is built, so a value
 * outside the union cannot survive to be used. Validating here as well would put the same
 * decision in two places and let them disagree.
 */
export function toPolicy(row: PolicyRow): DataProtectionPolicy {
  return {
    policyKey: row.policy_key,
    scope: row.scope as PolicyScope,
    classification: row.classification as Classification,
    atRest: row.at_rest as AtRest,
    blindIndex: row.blind_index,
    inTransit: row.in_transit as InTransit,
    logTreatment: row.log_treatment as LogTreatment,
    maskStrategy: row.mask_strategy as MaskStrategyName | null,
    uiVisibility: row.ui_visibility as UiVisibility,
    revealRoles: toRoleArray(row.reveal_roles),
    keyPurpose: row.key_purpose,
    enabled: row.enabled,
    note: row.note,
  };
}

/**
 * `jsonb` → `string[] | null`.
 *
 * `node-postgres` parses `jsonb` for us, so the common case is already an array. The string
 * branch covers a driver or a pool configured without the type parser (and a `json`-typed column
 * in some future migration); anything that is neither — a number, an object, `["a", 2]` — yields
 * `null` rather than a partially-usable array, because a malformed `reveal_roles` must mean
 * "nobody may reveal", not "these two of the three may".
 */
export function toRoleArray(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;

  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((item): item is string => typeof item === 'string')) return null;
  return Object.freeze([...parsed]);
}
