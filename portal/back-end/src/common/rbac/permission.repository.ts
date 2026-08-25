/**
 * T-013 — the permission layer's only door to the database.
 *
 * ### Why this file exists (an addition to T-013's declared "Files owned")
 *
 * The same three reasons `credential.repository.ts` and `session.repository.ts` record for
 * T-010/T-011, and one more that is specific to this task:
 *
 *  1. `PermissionCacheService` stays a decision-maker — what to cache, for how long, and what to
 *     do when a read fails — and none of those decisions need to know any SQL.
 *  2. Every branch of the fail-closed behaviour (TC-17) can then be driven deterministically
 *     from an in-memory double, including "the database is unreachable", which is not something
 *     a test can ask a real Postgres for on demand.
 *  3. **It cannot go through `ScopedRepository`, and the reason is structural, not stylistic.**
 *     `PermissionsGuard` runs at position 8 of 00-ARCHITECTURE.md §6; `TenancyScopeInterceptor`
 *     — which establishes the scope `ScopedRepository` requires — runs at position 9. Reading
 *     permissions through a scoped query would therefore be circular: the scope does not exist
 *     yet when the permission is checked. (It would also be meaningless: `role_entity_permissions`
 *     and `rbac_cache_config` are global configuration, not tenant data — see their entries in
 *     `scope-strategy.ts`, both `unrestricted`.)
 *
 * So the access is raw, parameterised SQL through the shared `Sequelize` instance, which is also
 * what keeps this file clean under T-013's own `no-raw-model-access` lint rule with no
 * `eslint-disable` anywhere (R2).
 *
 * **Every caller-supplied value below is a bound replacement.** There is no string interpolation
 * of any kind in this file — not even the frozen-status-literal exception `session.repository.ts`
 * documents, because none of these statements touches a partial index.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import type { PortalRole } from '@/database/portal-models';
import { RBAC_CONFIG_KEY } from './rbac.constants';

/** One `role_entity_permissions` row, already parsed. */
export interface PermissionGrant {
  readonly entity: string;
  readonly actions: readonly string[];
}

/**
 * The port `PermissionCacheService` depends on. An interface so the service can be unit-tested
 * against a double, and so the storage could change without touching a line of policy.
 */
export interface PermissionStore {
  /** Every grant for one role. Empty array = "this role has been granted nothing". */
  findGrantsForRole(role: PortalRole): Promise<readonly PermissionGrant[]>;
  /** `rbac_version:<role>`. */
  readRbacVersion(role: PortalRole): Promise<number>;
  /** Global `rbac_ttl_seconds`, or `null` when the row is missing or unparseable. */
  readTtlSeconds(): Promise<number | null>;
  /**
   * Increments `rbac_version:<role>` and returns the new value.
   *
   * The increment happens **in SQL**, not read-modify-write in JavaScript, so two concurrent
   * permission edits cannot both read `4` and both write `5`, leaving one edit's invalidation
   * silently unpublished to every other instance.
   */
  bumpRbacVersion(role: PortalRole): Promise<number>;
}

/** DI token — every consumer depends on {@link PermissionStore}, never on the class below. */
export const PERMISSION_STORE = Symbol('PERMISSION_STORE');

interface RawGrantRow {
  entity: string;
  actions: string | null;
}

@Injectable()
export class PermissionRepository implements PermissionStore {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * Reads one role's whole permission matrix in a single query.
   *
   * `actions` is a JSON array packed into `varchar(500)` (01-DATABASE.md §5.1, T-003
   * implementation note 4). It is parsed here rather than in the service so the service never
   * sees a string it might be tempted to `includes()` — `"view"` is a substring of
   * `["review"]`, and a substring match on a permission list is a privilege escalation waiting
   * for the right entity name.
   *
   * Malformed JSON yields **no actions**, not all actions. A row nobody can parse must grant
   * nothing; the alternative interpretation of a corrupt row is unbounded.
   */
  async findGrantsForRole(role: PortalRole): Promise<readonly PermissionGrant[]> {
    const rows = await this.sequelize.query<RawGrantRow>(
      `
      SELECT entity, actions
        FROM reward_config.role_entity_permissions
       WHERE role = :role
      `,
      { type: QueryTypes.SELECT, replacements: { role } },
    );

    return rows.map((row) => ({ entity: row.entity, actions: parseActions(row.actions) }));
  }

  async readRbacVersion(role: PortalRole): Promise<number> {
    const value = await this.readConfigValue(RBAC_CONFIG_KEY.versionFor(role));
    if (value === null) return 0;

    const parsed = Number.parseInt(value, 10);
    // `0` for a missing or unparseable row, matching `SessionRepository.readRbacVersion`
    // exactly. `0` is not a version any seed produces (T004_005 seeds every role at `1`), so a
    // cache keyed on it belongs to a generation nothing else shares — the entry is cold rather
    // than wrong.
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async readTtlSeconds(): Promise<number | null> {
    const value = await this.readConfigValue(RBAC_CONFIG_KEY.TTL_SECONDS);
    if (value === null) return null;

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  }

  /**
   * `UPDATE … SET config_value = (config_value::int + 1)` — atomic at the row level.
   *
   * The `~ '^[0-9]+$'` guard stops the cast from erroring on a hand-edited non-numeric value and
   * aborting the caller's transaction; a non-numeric version is reset to `1`, which is still a
   * *change*, and a change is all an invalidation needs to be.
   */
  async bumpRbacVersion(role: PortalRole): Promise<number> {
    const key = RBAC_CONFIG_KEY.versionFor(role);

    const rows = await this.sequelize.query<{ config_value: string }>(
      `
      INSERT INTO reward_config.rbac_cache_config (config_key, config_value, updated_at)
      VALUES (:key, '1', now())
      ON CONFLICT (config_key) DO UPDATE
        SET config_value = CASE
              WHEN reward_config.rbac_cache_config.config_value ~ '^[0-9]+$'
              THEN (reward_config.rbac_cache_config.config_value::bigint + 1)::text
              ELSE '1'
            END,
            updated_at = now()
      RETURNING config_value
      `,
      { type: QueryTypes.SELECT, replacements: { key } },
    );

    const parsed = Number.parseInt(rows[0].config_value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async readConfigValue(key: string): Promise<string | null> {
    const rows = await this.sequelize.query<{ config_value: string }>(
      `
      SELECT config_value
        FROM reward_config.rbac_cache_config
       WHERE config_key = :key
       LIMIT 1
      `,
      { type: QueryTypes.SELECT, replacements: { key } },
    );

    const row = rows[0];
    return row === undefined ? null : row.config_value;
  }
}

/**
 * Parses the packed `actions` array, tolerating every kind of malformed content by returning
 * nothing.
 *
 * Deliberately **not** `parseJsonColumn` from `src/database/util`: that helper's fallback is
 * whatever the caller passes, which is right for display data and wrong here. This one has a
 * single, non-negotiable fallback — the empty grant — and non-string entries are dropped rather
 * than coerced, so `[1, "view"]` grants `view` and nothing numeric.
 */
export function parseActions(raw: string | null): readonly string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((action): action is string => typeof action === 'string');
  } catch {
    return [];
  }
}
