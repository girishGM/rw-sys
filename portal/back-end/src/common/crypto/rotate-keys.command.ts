/**
 * T-016 — key rotation without downtime (07-DATA-PROTECTION.md §3, Implementation notes §7).
 *
 * The lifecycle, and why each step exists:
 *
 * ```
 *   1. insert the new key as 'active'  →  the previous active becomes 'rotating'
 *        both keys decrypt; only the new one encrypts. No downtime, no coordination.
 *   2. rotate()  →  re-encrypts every row still on an old kid, in batches
 *        mixed-vintage rows coexist throughout, because the kid travels in the ciphertext.
 *   3. retire the old key  →  it no longer decrypts anything
 *        refused while any configured target still holds a row under that kid.
 * ```
 *
 * ### Resumability (TC-17)
 *
 * There is no cursor, no checkpoint table and no `--resume` flag, on purpose. Each batch
 * runs in its own transaction, and the batch selector is "rows whose ciphertext does **not**
 * already start with the active kid". A row that was rewritten and committed no longer
 * matches; a row from an interrupted, rolled-back batch still does. So an interrupted run is
 * resumed by simply running it again, and running it twice over is a no-op. State that could
 * disagree with the data is state that will eventually disagree with the data.
 *
 * ### Why `starts_with()` and not `LIKE`
 *
 * A `kid` may contain `_` (07-DATA-PROTECTION.md §3's own example is `fld_2026_01`), and `_`
 * is a single-character wildcard in `LIKE`. `... LIKE 'v1.fld_2026_01.%'` would also match
 * `v1.fldX2026Y01.…`, so rows encrypted under a *different* key would be treated as already
 * rotated and quietly left behind on a key that is about to be retired. `starts_with()` is a
 * plain prefix test with no metacharacters.
 *
 * ### Scope note
 *
 * This file is the rotation *engine*: an injectable class with no `process`, `argv` or
 * `process.exit` in it. The ops CLI wrapper belongs in `src/database/cli/`, which T-016 does
 * not own (its "Files owned" list stops at `src/common/crypto/**`), so it is deliberately
 * left to the task that owns that directory. Everything TC-13…TC-17 exercise is here and is
 * callable directly.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import type { BlindIndexNormaliserName } from './blind-index.service';
import { BlindIndexService } from './blind-index.service';
import { ciphertextPrefixFor } from './ciphertext';
import { KeyRegistryError } from './crypto.errors';
import { FieldCryptoService } from './field-crypto.service';
import { KeyRegistryService, type KeyPurpose } from './key-registry.service';

/**
 * Schema-qualified table or bare column name. Rotation targets are code constants, never
 * user input — but they are still interpolated into SQL (identifiers cannot be bound as
 * parameters), so they are validated anyway. "It is only ever called with constants" is
 * true right up until the day it isn't.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

export interface BlindIndexRotationTarget {
  /** The deterministic index column, e.g. `email_bidx`. */
  column: string;
  /** The encrypted column it is derived from — must be one of the target's `columns`. */
  sourceColumn: string;
  normaliser: BlindIndexNormaliserName;
}

export interface RotationTarget {
  /** Schema-qualified, e.g. `reward_portal.portal_users`. */
  table: string;
  /** Single-column primary key. Composite keys are not supported — see `assertTarget`. */
  pkColumn: string;
  /** The AES-GCM encrypted columns to re-encrypt. */
  columns: string[];
  /**
   * Blind-index columns to recompute in the same pass. Needed when the `blind_index` key
   * itself changes: unlike field keys, a blind index carries no kid and cannot overlap, so
   * the only way to change that key is to rebuild every index from its source column.
   */
  blindIndex?: BlindIndexRotationTarget[];
  /**
   * AAD table name, if it differs from `table`. Defaults to `table`. Only set this if
   * existing ciphertext was written with a different binding — changing it otherwise makes
   * every existing row undecryptable.
   */
  aadTable?: string;
}

export interface RotateOptions {
  /** Rows per transaction. Larger batches mean longer row locks. */
  batchSize?: number;
  /** Count what would change and write nothing. */
  dryRun?: boolean;
  /** Safety bound so a non-converging run fails loudly instead of spinning forever. */
  maxBatches?: number;
  onProgress?: (progress: { table: string; rewritten: number; batches: number }) => void;
}

export interface RotateResult {
  table: string;
  /** Rows found needing rotation. In a dry run this is the only field that is populated. */
  pending: number;
  rewritten: number;
  batches: number;
  dryRun: boolean;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 100_000;

@Injectable()
export class RotateKeysCommand {
  private readonly logger = new Logger(RotateKeysCommand.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly keys: KeyRegistryService,
    private readonly fieldCrypto: FieldCryptoService,
    private readonly blindIndex: BlindIndexService,
  ) {}

  /**
   * Step 1 — promote `kid` to `active` and demote the current active key of the same purpose
   * to `rotating`. One transaction, demote first: `uq_ek_active_purpose` is a partial unique
   * index and is enforced per statement, so promoting first would violate it.
   *
   * Reloads the registry before returning, so the very next `encrypt()` uses the new key
   * (TC-14) without waiting for a restart.
   */
  async activateKey(kid: string): Promise<void> {
    const purpose = await this.sequelize.transaction(async (t) => {
      const [row] = await this.sequelize.query<{ purpose: string; status: string }>(
        `SELECT purpose, status FROM reward_portal.encryption_keys WHERE kid = :kid FOR UPDATE`,
        { replacements: { kid }, type: QueryTypes.SELECT, transaction: t },
      );
      if (row === undefined) {
        throw new KeyRegistryError(`No encryption_keys row with kid='${kid}'.`);
      }
      if (row.status === 'retired') {
        throw new KeyRegistryError(
          `Refusing to re-activate retired key '${kid}'. A retired key's material may already ` +
            `have been destroyed at its source; issue a new kid instead.`,
        );
      }

      await this.sequelize.query(
        `UPDATE reward_portal.encryption_keys
            SET status = 'rotating'
          WHERE purpose = :purpose AND status = 'active' AND kid <> :kid`,
        {
          replacements: { purpose: row.purpose, kid },
          type: QueryTypes.UPDATE,
          transaction: t,
        },
      );
      await this.sequelize.query(
        `UPDATE reward_portal.encryption_keys
            SET status = 'active', activated_at = now(), retired_at = NULL
          WHERE kid = :kid`,
        { replacements: { kid }, type: QueryTypes.UPDATE, transaction: t },
      );

      return row.purpose as KeyPurpose;
    });

    await this.keys.load();
    this.logger.log(`Key '${kid}' is now the active '${purpose}' key.`);
  }

  /**
   * Step 3 — retire `kid`, after which nothing decrypts under it.
   *
   * Refuses to retire the active key, and refuses while any row in `targets` still holds
   * ciphertext under it. `force` skips only the second check, and exists for the case where
   * the remaining rows are known-abandoned; it is not a "make the error go away" flag — the
   * rows it skips become permanently unreadable.
   */
  async retireKey(
    kid: string,
    targets: RotationTarget[] = [],
    options: { force?: boolean } = {},
  ): Promise<void> {
    const [row] = await this.sequelize.query<{ status: string }>(
      `SELECT status FROM reward_portal.encryption_keys WHERE kid = :kid`,
      { replacements: { kid }, type: QueryTypes.SELECT },
    );
    if (row === undefined) {
      throw new KeyRegistryError(`No encryption_keys row with kid='${kid}'.`);
    }
    if (row.status === 'active') {
      throw new KeyRegistryError(
        `Refusing to retire '${kid}': it is the active key. Activate a replacement first.`,
      );
    }

    if (!options.force) {
      for (const target of targets) {
        const remaining = await this.countUnder(target, kid);
        if (remaining > 0) {
          throw new KeyRegistryError(
            `Refusing to retire '${kid}': ${remaining} row(s) in ${target.table} are still ` +
              `encrypted under it. Run rotate() first — retiring now makes them unreadable.`,
          );
        }
      }
    }

    await this.sequelize.query(
      `UPDATE reward_portal.encryption_keys
          SET status = 'retired', retired_at = now()
        WHERE kid = :kid`,
      { replacements: { kid }, type: QueryTypes.UPDATE },
    );
    await this.keys.load();
    this.logger.log(`Key '${kid}' retired.`);
  }

  /** Rotates several targets in order, stopping at the first failure. */
  async rotateAll(targets: RotationTarget[], options: RotateOptions = {}): Promise<RotateResult[]> {
    const results: RotateResult[] = [];
    for (const target of targets) {
      results.push(await this.rotate(target, options));
    }
    return results;
  }

  /**
   * Step 2 — re-encrypt every row of `target` that is not already on the active field key.
   *
   * One transaction per batch, rows locked `FOR UPDATE` for the whole batch so a concurrent
   * writer cannot have its update silently overwritten by a re-encrypted stale value.
   */
  async rotate(target: RotationTarget, options: RotateOptions = {}): Promise<RotateResult> {
    assertTarget(target);

    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new KeyRegistryError(`batchSize must be a positive integer, received ${batchSize}.`);
    }
    const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;

    const activeKid = this.keys.getActiveKey('field').kid;
    const pending = await this.countStale(target, activeKid);

    if (options.dryRun === true) {
      return { table: target.table, pending, rewritten: 0, batches: 0, dryRun: true };
    }

    let rewritten = 0;
    let batches = 0;

    for (;;) {
      const done = await this.rotateBatch(target, activeKid, batchSize);
      if (done === 0) break;

      rewritten += done;
      batches += 1;
      options.onProgress?.({ table: target.table, rewritten, batches });

      if (batches > maxBatches) {
        throw new KeyRegistryError(
          `Rotation of ${target.table} exceeded ${maxBatches} batches without completing. ` +
            `Aborting rather than looping — something is rewriting rows as fast as they are ` +
            `rotated, or the active key changed mid-run.`,
        );
      }
    }

    this.logger.log(
      `Rotated ${target.table}: ${rewritten} row(s) re-encrypted onto '${activeKid}' ` +
        `in ${batches} batch(es).`,
    );
    return { table: target.table, pending, rewritten, batches, dryRun: false };
  }

  /**
   * One batch, one transaction. Returns how many rows were rewritten; `0` means the table is
   * fully rotated and the caller's loop terminates.
   */
  private async rotateBatch(
    target: RotationTarget,
    activeKid: string,
    batchSize: number,
  ): Promise<number> {
    const pk = target.pkColumn;
    const aadTable = target.aadTable ?? target.table;
    const prefix = ciphertextPrefixFor(activeKid);
    const blindIndexes = target.blindIndex ?? [];

    return this.sequelize.transaction(async (t) => {
      const rows = await this.selectStale(target, prefix, batchSize, t);
      if (rows.length === 0) return 0;

      for (const row of rows) {
        const aad = FieldCryptoService.aadFor(aadTable, row[pk] as string | number);
        const assignments: string[] = [];
        const replacements: Record<string, unknown> = { pk: row[pk] };

        for (const [index, column] of target.columns.entries()) {
          const current = row[column];
          if (current === null || current === undefined) continue;
          if (typeof current !== 'string') {
            throw new KeyRegistryError(
              `${target.table}.${column} (${pk}=${String(row[pk])}) is not a string; only ` +
                `text ciphertext columns can be rotated.`,
            );
          }

          // decrypt with the kid embedded in the value, re-encrypt with the active key.
          // Any failure here (a plaintext value in a ciphertext column, a retired key,
          // tampering) throws a typed error naming the row but never its contents.
          const plaintext = this.fieldCrypto.decrypt(current, { aad });
          const bind = `c${index}`;
          assignments.push(`${column} = :${bind}`);
          replacements[bind] = this.fieldCrypto.encrypt(plaintext, { aad });

          for (const bidx of blindIndexes) {
            if (bidx.sourceColumn !== column) continue;
            const bidxBind = `b${index}`;
            assignments.push(`${bidx.column} = :${bidxBind}`);
            replacements[bidxBind] = this.blindIndex.compute(plaintext, bidx.normaliser);
          }
        }

        if (assignments.length === 0) {
          // Selected as stale but nothing to rewrite: the predicate and the row disagree,
          // which would loop forever. Fail loudly instead.
          throw new KeyRegistryError(
            `${target.table} row ${pk}=${String(row[pk])} matched the rotation predicate but ` +
              `has no rotatable column value. Refusing to loop.`,
          );
        }

        await this.sequelize.query(
          `UPDATE ${target.table} SET ${assignments.join(', ')} WHERE ${pk} = :pk`,
          { replacements, type: QueryTypes.UPDATE, transaction: t },
        );
      }

      return rows.length;
    });
  }

  /** The stale-row selector, shared by the batch loop so the predicate cannot drift. */
  private async selectStale(
    target: RotationTarget,
    prefix: string,
    batchSize: number,
    transaction: Transaction,
  ): Promise<Record<string, unknown>[]> {
    const projection = [target.pkColumn, ...target.columns].join(', ');
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT ${projection}
         FROM ${target.table}
        WHERE ${staleClause(target)}
        ORDER BY ${target.pkColumn}
        LIMIT :limit
          FOR UPDATE`,
      {
        replacements: { prefix, limit: batchSize },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
  }

  /** How many rows still need rotating onto `activeKid`. */
  async countStale(target: RotationTarget, activeKid?: string): Promise<number> {
    assertTarget(target);
    const kid = activeKid ?? this.keys.getActiveKey('field').kid;
    const [row] = await this.sequelize.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${target.table} WHERE ${staleClause(target)}`,
      { replacements: { prefix: ciphertextPrefixFor(kid) }, type: QueryTypes.SELECT },
    );
    return Number(row.count);
  }

  /** How many rows are still encrypted under a specific (usually about to be retired) kid. */
  async countUnder(target: RotationTarget, kid: string): Promise<number> {
    assertTarget(target);
    const clause = target.columns
      .map((column) => `(${column} IS NOT NULL AND starts_with(${column}, :prefix))`)
      .join(' OR ');
    const [row] = await this.sequelize.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${target.table} WHERE ${clause}`,
      { replacements: { prefix: ciphertextPrefixFor(kid) }, type: QueryTypes.SELECT },
    );
    return Number(row.count);
  }
}

/** "At least one encrypted column holds a value that is not already on the active kid." */
function staleClause(target: RotationTarget): string {
  return target.columns
    .map((column) => `(${column} IS NOT NULL AND NOT starts_with(${column}, :prefix))`)
    .join(' OR ');
}

/**
 * Validates every identifier before it is interpolated into SQL, and checks the internal
 * consistency the queries assume.
 */
export function assertTarget(target: RotationTarget): void {
  const check = (value: string, what: string): void => {
    if (!SAFE_IDENTIFIER.test(value)) {
      throw new KeyRegistryError(
        `Rotation target ${what} '${value}' is not a plain lowercase SQL identifier. ` +
          `Identifiers cannot be bound as parameters, so only this shape is accepted.`,
      );
    }
  };

  check(target.table, 'table');
  check(target.pkColumn, 'pkColumn');
  if (target.pkColumn.includes('.')) {
    throw new KeyRegistryError(
      `Rotation target pkColumn '${target.pkColumn}' must be unqualified.`,
    );
  }
  if (target.columns.length === 0) {
    throw new KeyRegistryError(`Rotation target ${target.table} lists no columns to rotate.`);
  }
  for (const column of target.columns) {
    check(column, 'column');
    if (column.includes('.')) {
      throw new KeyRegistryError(`Rotation target column '${column}' must be unqualified.`);
    }
  }
  if (target.aadTable !== undefined) check(target.aadTable, 'aadTable');

  for (const bidx of target.blindIndex ?? []) {
    check(bidx.column, 'blindIndex.column');
    check(bidx.sourceColumn, 'blindIndex.sourceColumn');
    if (!target.columns.includes(bidx.sourceColumn)) {
      throw new KeyRegistryError(
        `Blind-index source '${bidx.sourceColumn}' is not among the rotated columns of ` +
          `${target.table}; it would never be recomputed.`,
      );
    }
  }
}
