import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-018 — `reward_portal.portal_sessions.transport_key_enc`.
 *
 * ### The column already exists, and that is the point of this file
 *
 * 07-DATA-PROTECTION.md §5 specified `transport_key_enc` but 01-DATABASE.md §2.3's own DDL had
 * dropped it — schema drift between two design documents, caught by architect review **AR-03**
 * and fixed *before* T002_004 was written. So the column has been in place since Wave 0 and this
 * migration must not create it; doing so would fail on a real database and would quietly diverge
 * from the table T-002 owns.
 *
 * What is added here is the guarantee nobody has stated yet, in the form the rest of this
 * codebase states such things — a `CHECK` constraint:
 *
 * > **`transport_key_enc` is either NULL or a T-016 ciphertext envelope. It is never a key.**
 *
 * The reasoning is `T016_001`'s `ck_ek_key_ref_pointer` applied one table over. A raw AES-256 key
 * base64-encodes to 44 characters and fits the `varchar(512)` column perfectly, so a future
 * refactor that stored the derived session key directly would work, pass every functional test,
 * and put the key that protects every payload in the same database as the payloads. The regex
 * below makes that an INSERT error rather than a silent catastrophe: it demands the `v1.<kid>.`
 * prefix that `formatCiphertext` produces and that nothing else does.
 *
 * It is deliberately a *prefix* check rather than a full envelope parse. A CHECK constraint is
 * evaluated on every write to a hot table; the cheap test catches the mistake this exists to
 * catch (a plaintext key), and `FieldCryptoService.decrypt` does the real, exhaustive parse.
 *
 * Layered with, not instead of, the application: `HandshakeService` encrypts through T-016's
 * `FieldCryptoService` and never writes anything else. Two independent layers, because this is
 * the one mistake nobody notices from the outside.
 *
 * ### No DDL against `reward_config` (AGENT-PROTOCOL R1)
 *
 * `portal_sessions` lives in `reward_portal`. Nothing here touches `reward_config`.
 *
 * ### No rows, no keys
 *
 * There is no seed. The session key is minted per login by an ECDH handshake and wrapped with the
 * `field` key ring, whose material lives in the environment or KMS (`encryption_keys.key_ref`) —
 * never in a migration, never in git (R4).
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    // Fail loudly rather than silently doing nothing if AR-03's column is ever removed: a
    // constraint added to a column that does not exist would error anyway, but this says why.
    const [column] = await context.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'reward_portal'
           AND table_name   = 'portal_sessions'
           AND column_name  = 'transport_key_enc'
      ) AS exists;
      `,
      { type: QueryTypes.SELECT, transaction: t },
    );
    if (!column.exists) {
      throw new Error(
        'reward_portal.portal_sessions.transport_key_enc is missing. It is created by ' +
          'T002_004 (architect review AR-03); T-018 adds a constraint to it and does not own ' +
          'its creation. Run the T-002 migrations first.',
      );
    }

    await context.query(
      `
      ALTER TABLE reward_portal.portal_sessions
        ADD CONSTRAINT ck_portal_sessions_transport_key_enc
        CHECK (transport_key_enc IS NULL OR transport_key_enc ~ '^v1\\.[A-Za-z0-9_-]{1,40}\\.');
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `
      COMMENT ON COLUMN reward_portal.portal_sessions.transport_key_enc IS
        'T-018. The session transport key (AES-256-GCM, derived at login by ECDH P-256 + '
        'HKDF-SHA256), wrapped with the T-016 field key ring and bound to this row by AAD. '
        'NEVER a raw key: ck_portal_sessions_transport_key_enc enforces the v1 envelope prefix. '
        'Destroyed on logout; unreadable once the session is not active.';
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Drops the constraint and the comment. The column itself is T002_004's and stays.
 *
 * Rolling back removes a safety net, not data: any `transport_key_enc` already written remains
 * exactly as it was and continues to decrypt. This is the one direction in this task that is
 * genuinely reversible, which is why the rollback of *T-018 as a whole* is `mode: "off"` in
 * `config/data-protection.json` rather than this migration.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `ALTER TABLE reward_portal.portal_sessions
         DROP CONSTRAINT IF EXISTS ck_portal_sessions_transport_key_enc;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `COMMENT ON COLUMN reward_portal.portal_sessions.transport_key_enc IS NULL;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
