import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.data_protection_policies` — 07-DATA-PROTECTION.md §2, column for column.
 *
 * One row per protected field; five enforcement points read it (§1). Adding a protected field is
 * *"a policy row plus a migration, never a code change in five places"* — this is the table that
 * makes that true.
 *
 * ### Three constraints added beyond the design doc's DDL, and why
 *
 * `ck_dpp_blind_index_class` — §6 states the rule in prose and assigns the check to T-016:
 * *"The policy table forbids `blind_index = true` on any field whose classification is not `pii`
 * or `secret`"*. T-016 implemented it as `assertBlindIndexAllowed()`, which runs when the policy
 * set is **built**. That stops a bad row being *used*; it does not stop it being *written*, and
 * T-017 TC-23 requires *"migration/validation rejects it"* — both halves. So the rule is a
 * `CHECK` here as well. The reason it matters enough for two layers: a blind index over
 * low-cardinality data is not weak encryption, it is *no* encryption — five distinct values
 * produce five distinct digests and a `GROUP BY` recovers the mapping.
 *
 * `ck_dpp_at_rest_key_purpose` — a row saying `at_rest='aes_256_gcm'` with no `key_purpose` names
 * no key ring, so the hook generator would have nothing to look up. Left to runtime it surfaces
 * as a failed write on the first INSERT into that table, in production, which is the worst
 * possible moment to discover it.
 *
 * `ck_dpp_key_shape` — `policy_key` must be exactly three dot-separated identifier segments
 * (`<schema>.<table>.<column>` or `dto.<Name>.<field>`). Everything downstream splits on the last
 * dot to get the container, so a two- or four-segment key silently resolves against a container
 * that does not exist and the field ends up governed by the fail-closed default instead of by
 * its own row. Cheap to state here; invisible if not.
 *
 * ### Two constraints from the doc that are worth reading twice
 *
 * `ck_dpp_mask_strategy` (§2's own comment: *"A masked presentation without a strategy silently
 * degrades to plain. Forbid it."*) and `ck_dpp_reveal_roles`. Both encode the same insight: a
 * protection that is configured but incomplete fails **open**, so the incomplete state must be
 * unstorable. TC-24 is the test for the first.
 *
 * ### Why no `updated_at` trigger
 *
 * `updated_at` defaults to `now()` and is set explicitly by the seed's `ON CONFLICT DO UPDATE`.
 * A `BEFORE UPDATE` trigger would be the thorough answer, and T-005's experience with triggers on
 * a live schema (its own task file flags them as the High-risk part) argues for not adding one
 * where a column default and an explicit `SET` already cover every writer this table has.
 *
 * Grants: `T002_008_grants.ts` set `ALTER DEFAULT PRIVILEGES IN SCHEMA reward_portal GRANT ALL ON
 * TABLES TO reward_app`, and this migration runs as the same privileged role, so `reward_app`
 * picks the table up automatically. Nothing to grant here.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.data_protection_policies (
          id              int generated always as identity primary key,
          policy_key      varchar(160) not null,   -- 'reward_config.merchants.contact_email'
                                                   -- or 'dto.CreateUserResponse.temporaryPassword'
          scope           varchar(20)  not null,   -- column | dto_field
          classification  varchar(20)  not null,   -- public|internal|confidential|pii|secret
          at_rest         varchar(20)  not null default 'none',      -- none|aes_256_gcm|hmac_sha256
          blind_index     boolean      not null default false,
          in_transit      varchar(20)  not null default 'tls_only',  -- tls_only|payload_encrypt
          log_treatment   varchar(20)  not null default 'plain',     -- plain|mask|hash|omit
          mask_strategy   varchar(30)  null,       -- email|phone|last4|first_last|full
          ui_visibility   varchar(20)  not null default 'plain',     -- plain|masked|reveal_on_demand|never
          reveal_roles    jsonb        null,       -- ["super_admin"] — roles allowed to unmask
          key_purpose     varchar(40)  null,       -- which key ring in encryption_keys
          enabled         boolean      not null default true,
          note            varchar(300) null,
          created_at      timestamptz  not null default now(),
          updated_at      timestamptz  not null default now(),

          constraint uq_dpp_key unique (policy_key),
          constraint ck_dpp_scope     check (scope in ('column','dto_field')),
          constraint ck_dpp_class     check (classification in
              ('public','internal','confidential','pii','secret')),
          constraint ck_dpp_at_rest   check (at_rest in ('none','aes_256_gcm','hmac_sha256')),
          constraint ck_dpp_transit   check (in_transit in ('tls_only','payload_encrypt')),
          constraint ck_dpp_log       check (log_treatment in ('plain','mask','hash','omit')),
          constraint ck_dpp_ui        check (ui_visibility in
              ('plain','masked','reveal_on_demand','never')),
          constraint ck_dpp_mask_value check (mask_strategy is null or mask_strategy in
              ('email','phone','last4','first_last','full')),

          -- A masked presentation without a strategy silently degrades to plain. Forbid it. (§2)
          constraint ck_dpp_mask_strategy
              check (log_treatment <> 'mask' or mask_strategy is not null),
          constraint ck_dpp_reveal_roles
              check (ui_visibility <> 'reveal_on_demand' or reveal_roles is not null),

          -- Beyond §2's DDL — see this file's header.
          constraint ck_dpp_blind_index_class
              check (blind_index = false or classification in ('pii','secret')),
          constraint ck_dpp_blind_index_scope
              check (blind_index = false or scope = 'column'),
          constraint ck_dpp_at_rest_key_purpose
              check (at_rest = 'none' or key_purpose is not null),
          constraint ck_dpp_key_shape
              check (policy_key ~ '^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*){2}$')
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    // The boot read is "every row, ordered by key" and the hook generator groups by container, so
    // the only index worth having beyond `uq_dpp_key` is one that makes "everything encrypted"
    // cheap to answer. Partial, because the answer is a handful of rows out of a small table.
    await context.query(
      `CREATE INDEX ix_dpp_at_rest ON reward_portal.data_protection_policies(policy_key)
        WHERE at_rest <> 'none' AND enabled;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Drops the table.
 *
 * **This is the configuration, not the data.** Rolling back removes the classification of every
 * field; it does not decrypt anything. A process that boots after this rollback finds no policy
 * rows, fails closed (masking and omitting), and installs no encryption hooks — so columns that
 * already hold `v1.…` ciphertext will read back as ciphertext, because the `afterFind` hook that
 * decrypts them is generated from the rows this statement deletes. T-017's Rollback section says
 * the same; it is repeated at the point of no return on purpose.
 */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  await context.query(`DROP TABLE IF EXISTS reward_portal.data_protection_policies CASCADE;`, {
    type: QueryTypes.RAW,
  });
}
