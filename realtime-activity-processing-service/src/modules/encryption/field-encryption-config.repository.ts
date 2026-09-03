/**
 * T-RAP-012. Repository for `realtime_activity_processing.field_encryption_config`
 * (`01-DATABASE.md` §10) — which logical fields must be redacted from log lines, per scope.
 *
 * Talks to Postgres with parameterised `sequelize.query(...)`, matching this project's own
 * migrations-are-raw-SQL / no `@Table` ORM model convention (see
 * `campaign-config-snapshot.repository.ts`'s identical precedent, same file-scope owner).
 *
 * Owns its own connection (`ENCRYPTION_SEQUELIZE`, provided by `encryption.module.ts`) rather than
 * importing `CampaignConfigCacheModule` for its exported `CAMPAIGN_CACHE_SEQUELIZE` — this task's
 * `Depends on` is only T-RAP-001/T-RAP-002, not T-RAP-010, and staying self-contained avoids a
 * load-order coupling neither task actually needs.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import type {
  ConfigScopeLevel,
  FieldEncryptionConfigRow,
} from '@/database/models/field-encryption-config.model';

/**
 * DI token for this module's own runtime Postgres connection (the least-privilege `rap_app`
 * role — AGENT-PROTOCOL.md R1 — never the migration role from `src/database/migration-connection.ts`).
 * Defined here (not a dedicated constants file — this task's "Files owned" list grants exactly
 * four `.ts` files under `src/modules/encryption/`, none of them a constants file), matching
 * `campaign-config-snapshot.repository.ts`'s own precedent for `CAMPAIGN_CACHE_SEQUELIZE`.
 */
export const ENCRYPTION_SEQUELIZE = Symbol('ENCRYPTION_SEQUELIZE');

export interface UpsertFieldEncryptionConfigData {
  scopeLevel: ConfigScopeLevel;
  /** `null` for `'global'` scope — `01-DATABASE.md` §10's own note. */
  scopeRef: string | null;
  fieldName: string;
  isEncrypted: boolean;
  addedBy: string;
}

@Injectable()
export class FieldEncryptionConfigRepository {
  constructor(@Inject(ENCRYPTION_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /** Every configured rule, across every scope — what `LogRedactorService` rebuilds its in-memory
   * resolution map from, at process start and on every later refresh. */
  async findAll(): Promise<FieldEncryptionConfigRow[]> {
    return this.sequelize.query<FieldEncryptionConfigRow>(
      `SELECT * FROM realtime_activity_processing.field_encryption_config
        ORDER BY scope_level, scope_ref, field_name`,
      { type: QueryTypes.SELECT },
    );
  }

  /**
   * Insert-or-replace for one `(scope_level, scope_ref, field_name)` rule. Deliberately two
   * sequential statements inside one explicit transaction, **not** a single `WITH deleted AS
   * (DELETE ...) INSERT ...` statement and **not** `ON CONFLICT (...) DO UPDATE`:
   *
   * - Postgres unique indexes treat two `NULL`s as *distinct* (confirmed directly against this
   *   service's own real Postgres 16 server — see `001_seed_field_encryption_config.ts`'s header
   *   for the same finding), so a naive `ON CONFLICT` here would silently duplicate a `'global'`
   *   row (whose `scope_ref` is always `NULL`) on a second call.
   * - A single statement combining both via a data-modifying CTE looks NULL-safe (the `DELETE`'s
   *   own `IS NOT DISTINCT FROM` is) but is not actually correct: **confirmed directly against
   *   this service's own real Postgres 16 server while implementing this task** — Postgres
   *   documents that every sub-statement in a `WITH` clause runs against the *same* snapshot
   *   ("they cannot see one another's effects on the target tables"), so the `INSERT` does not
   *   see the `DELETE`'s removal and raises `duplicate key value violates unique constraint
   *   uc_field_encryption_config` whenever a matching row already existed. Two statements inside
   *   one `transaction()` block gives genuine sequential visibility instead: the `INSERT` is
   *   guaranteed to run after the `DELETE`'s effects are visible within that same transaction.
   */
  async upsert(data: UpsertFieldEncryptionConfigData): Promise<void> {
    const replacements = {
      scopeLevel: data.scopeLevel,
      scopeRef: data.scopeRef,
      fieldName: data.fieldName,
      isEncrypted: data.isEncrypted,
      addedBy: data.addedBy,
    };

    await this.sequelize.transaction(async (transaction) => {
      await this.sequelize.query(
        `DELETE FROM realtime_activity_processing.field_encryption_config
          WHERE scope_level = :scopeLevel
            AND scope_ref IS NOT DISTINCT FROM :scopeRef
            AND field_name = :fieldName`,
        { type: QueryTypes.RAW, replacements, transaction },
      );
      await this.sequelize.query(
        `INSERT INTO realtime_activity_processing.field_encryption_config
           (scope_level, scope_ref, field_name, is_encrypted, added_by)
         VALUES (:scopeLevel, :scopeRef, :fieldName, :isEncrypted, :addedBy)`,
        { type: QueryTypes.RAW, replacements, transaction },
      );
    });
  }
}
