import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * `reward_portal.agent_sessions` + `reward_portal.agent_session_events` — T-048,
 * 10-AI-CAMPAIGN-AGENT.md §7:
 *
 * > *"Sessions persist in `reward_portal.agent_sessions` / `agent_session_events`, append-only. A
 * > maker can resume tomorrow; a reviewer can read exactly what was asked and answered."*
 *
 * ### Two tables, because they have opposite lifecycles
 *
 * A session's **state** is mutable by definition — the slot store fills in as the conversation
 * proceeds, and a resumed session (TC-21) is exactly "the last state, reloaded". A session's
 * **events** are the conversation itself, and a conversation that could be rewritten after the
 * fact is not evidence of anything (TC-22). So `agent_sessions` holds `SELECT, INSERT, UPDATE` and
 * `agent_session_events` holds `SELECT, INSERT` only, with `UPDATE`/`DELETE` revoked at the
 * privilege level — the same treatment `T037_002` gives the campaign audit trail, and for the same
 * reason: an ORM bug or an injected statement must not be able to rewrite history.
 *
 * Note that `reward_portal`'s `ALTER DEFAULT PRIVILEGES … GRANT ALL` (T002_008) would otherwise
 * hand both tables every privilege automatically. The explicit `GRANT` + `REVOKE` pairs below are
 * what make that default safe here.
 *
 * ### What is deliberately *not* stored
 *
 * **No raw prompt, and no model output beyond what the maker was actually shown.** §7 is explicit:
 * *"Every LLM call records model, prompt hash, token counts and latency — **not** raw prompt
 * content, which may carry PII."* `agent_session_events.meta` carries that telemetry; the
 * `content` column carries the human-readable turn (the maker's own message, or the assistant's
 * reply as rendered), which is the thing a reviewer must be able to read. Tool results are
 * recorded as the *option labels offered*, never as a database row dump.
 *
 * ### `slots`, `offered_options` and `plan` are `jsonb`
 *
 * Same reasoning `T047_001` gives for `allowed_sections`: this is a brand-new `reward_portal`
 * table with no legacy varchar-holding-JSON convention to honour, and `jsonb` gives real
 * structural validation (`ck_as_slots` and friends assert the top-level type). The *contents* are
 * validated in application code against Zod schemas, because a CHECK constraint enumerating slot
 * keys would need re-migrating every time the conversation gains a step.
 *
 * `offered_options` is the load-bearing one, and it is worth naming why a conversation-state table
 * carries a security-relevant column: it is the set of `optionId` values the tools have actually
 * handed the model, and it is what makes TC-7/TC-10 fail closed. An id the model invented was
 * never written here, so it fails the offered check before it is ever resolved — and even if it
 * somehow passed, `ScopedRepository` re-resolution (TC-8/TC-9) is the second, independent gate.
 * Neither gate trusts the model.
 *
 * ### Foreign keys point at `portal_users`, not `admin_users`
 *
 * Gap G1 again (see `T037_002`'s header): the actor here is a `maker`, and `ck_admin_users_role`
 * cannot represent one. `campaign_id` points at `reward_config.tenant_campaigns(id)` because that
 * *is* the row the session produced, and `ON DELETE RESTRICT` for the same reason every other
 * portal FK uses it — a campaign is never hard-deleted in this system.
 */
export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(
      `
      CREATE TABLE reward_portal.agent_sessions (
          id               uuid          not null default gen_random_uuid() primary key,
          tenant_id        int           not null,
          portal_user_id   int           not null,
          state            varchar(20)   not null default 'collecting',
          archetype        varchar(40)   null,
          slots            jsonb         not null default '{}'::jsonb,
          offered_options  jsonb         not null default '{}'::jsonb,
          plan             jsonb         null,
          plan_hash        char(64)      null,
          campaign_id      int           null,
          -- The stall detector (§9: "after 3 turns with no slot progress, offer the wizard").
          -- Persisted rather than held in memory so a maker cannot reset it by reloading the page.
          no_progress_turns smallint     not null default 0,
          turn_count       int           not null default 0,
          created_at       timestamptz   not null default now(),
          updated_at       timestamptz   not null default now(),

          constraint ck_as_state check (state in (
              'collecting','reviewing','created','abandoned','error')),
          constraint ck_as_slots   check (jsonb_typeof(slots) = 'object'),
          constraint ck_as_offered check (jsonb_typeof(offered_options) = 'object'),
          constraint ck_as_plan    check (plan is null or jsonb_typeof(plan) = 'object'),
          -- A created session must name what it created; nothing else may.
          constraint ck_as_campaign check (
              (state = 'created' and campaign_id is not null)
              or (state <> 'created' and campaign_id is null)),
          constraint fk_as_tenant foreign key (tenant_id)
              references reward_config.tenants(id) on delete restrict,
          constraint fk_as_user foreign key (portal_user_id)
              references reward_portal.portal_users(id) on delete restrict,
          constraint fk_as_campaign foreign key (campaign_id)
              references reward_config.tenant_campaigns(id) on delete restrict
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    // The only list this table serves: "my sessions, newest first" (the resume picker).
    await context.query(
      `CREATE INDEX ix_as_owner
           ON reward_portal.agent_sessions(portal_user_id, updated_at desc);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `
      CREATE TABLE reward_portal.agent_session_events (
          id           bigint generated always as identity primary key,
          session_id   uuid          not null,
          seq          int           not null,
          role         varchar(20)   not null,
          content      text          null,
          meta         jsonb         null,
          created_at   timestamptz   not null default now(),

          constraint ck_ase_role check (role in ('user','assistant','tool','system')),
          constraint ck_ase_meta check (meta is null or jsonb_typeof(meta) = 'object'),
          -- Append-only in shape as well as in privilege: a gap or a repeat in the sequence is a
          -- visible tampering signal rather than a rendering quirk.
          constraint uq_ase_seq unique (session_id, seq),
          constraint fk_ase_session foreign key (session_id)
              references reward_portal.agent_sessions(id) on delete restrict
      );
      `,
      { type: QueryTypes.RAW, transaction: t },
    );

    await context.query(
      `CREATE INDEX ix_ase_session ON reward_portal.agent_session_events(session_id, seq);`,
      { type: QueryTypes.RAW, transaction: t },
    );

    // Least privilege, per verb actually used — 01-DATABASE.md §3.
    await context.query(
      `GRANT SELECT, INSERT, UPDATE ON reward_portal.agent_sessions TO reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `REVOKE DELETE, TRUNCATE ON reward_portal.agent_sessions FROM reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `GRANT SELECT, INSERT ON reward_portal.agent_session_events TO reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );
    await context.query(
      `REVOKE UPDATE, DELETE, TRUNCATE ON reward_portal.agent_session_events FROM reward_app;`,
      { type: QueryTypes.RAW, transaction: t },
    );

    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** R7 — a working `down()`. Events are dropped before sessions, since they hold the FK to it. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    await context.query(`DROP TABLE IF EXISTS reward_portal.agent_session_events CASCADE;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await context.query(`DROP TABLE IF EXISTS reward_portal.agent_sessions CASCADE;`, {
      type: QueryTypes.RAW,
      transaction: t,
    });
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
