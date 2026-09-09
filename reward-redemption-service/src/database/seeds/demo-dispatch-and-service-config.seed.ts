import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * T-RR-046. Seeds the `service_config` `GLOBAL` rows this plan's own design docs name a default
 * for that are **not** already covered by an earlier migration — this task's own scope note asks
 * for "every `service_config` key this plan's design docs actually name," but by the time this
 * task landed, `015_seed_service_config_defaults.ts` (T-RR-051) and
 * `016_seed_campaign_config_ttl.ts` (T-RR-068) already seed all five `cache.ttl.*.seconds` keys,
 * `cache.reconciliationPoll.intervalSeconds`, and both `completionSweep.*` keys (confirmed by
 * direct read of both files — `src/database/migrations/**` is `agent-rr-foundation`'s own file
 * scope, R3, so this task adds only what those two migrations do not already cover, rather than
 * re-inserting rows that already exist and would violate `uq_sc_key_scope`).
 *
 * The three keys this migration actually adds — every one confirmed by direct grep of every
 * `.resolve('<key>', ...)` call site in `src/` as of this writing, each of which already documents
 * (in `dispatch.config.ts`) that it falls back to a hardcoded default with a one-time warn log
 * specifically because "this key is expected to be unseeded until T-RR-046 lands":
 *   - `dispatch.kafka.attemptsBeforeFallback` (`dispatch.config.ts`,
 *     `resolveKafkaAttemptsBeforeFallback`) — `value_type='int'`, default `3`, matching that
 *     file's own `DEFAULT_KAFKA_ATTEMPTS_BEFORE_FALLBACK`.
 *   - `dispatch.outbox.pollIntervalSeconds` (`dispatch.config.ts`,
 *     `resolveOutboxPollIntervalMs`) — `value_type='int'`, default `5` (seconds; that file
 *     multiplies by 1000 itself), matching `DEFAULT_OUTBOX_POLL_INTERVAL_MS` (5000ms) converted
 *     to seconds.
 *   - `dispatch.retry.maxAttempts` (`dispatch.config.ts`, `resolveDispatchRetryMaxAttempts`) —
 *     `value_type='int'`, default `5`, matching `DEFAULT_DISPATCH_RETRY_MAX_ATTEMPTS` — a
 *     *different* retry budget from `external_reward_system_config.max_retry_attempts`
 *     (`01-DATABASE.md` §3's own per-connector column); see that file's own header for why the
 *     two must never be conflated.
 *
 * **`connectors.coreBanking.stubOutcome` (`core-banking.connector.ts`,
 * `CORE_BANKING_STUB_OUTCOME_CONFIG_KEY`) is deliberately NOT seeded here, as a documented
 * deviation from this task's own scope note** (which named all four keys, this one included).
 * Reproduced directly while building this task: seeding a permanent `GLOBAL` row for this key
 * collides with `test/connectors/core-banking.connector.spec.ts`'s own `afterAll`, which runs an
 * unscoped `DELETE FROM reward_redemption.service_config WHERE config_key = :key` for this exact
 * key — no `scope_level`/`scope_ref` filter, unlike that same file's own `clearStubOutcome()`
 * helper a few lines below it, which scopes correctly. That unconditionally removes any row for
 * this key, including a permanent `GLOBAL` one this seed would otherwise insert, non-
 * deterministically breaking `npm test` depending on jest's own parallel worker scheduling
 * (confirmed by two full `npm test` runs: seeded, the collision reproduces; unseeded, it does
 * not). `test/connectors/**` is `agent-rr-integration`'s own file scope, not this task's own (R3)
 * — filed as **T-RR-072** rather than fixed here (`AGENT-PROTOCOL.md` §7.1); this task's own
 * completion report explains why local verification proceeds without waiting on it. Functionally
 * this omission changes nothing observable: `core-banking.connector.ts`'s own
 * `resolveStubOutcome()` already falls back to `DEFAULT_STUB_OUTCOME = 'SUCCESS'` — the exact same
 * value this row would have held — whenever no row resolves at any scope, so every caller sees
 * identical behaviour whether or not this one `GLOBAL` row exists. Once T-RR-072 lands, adding
 * this fourth row back is a one-line follow-up (or T-RR-072's own fix can add it directly, since it
 * already needs its own file-scope grant here to fix the DELETE).
 *
 * **`dispatch_channel_config`'s own `GLOBAL` row is deliberately NOT (re-)seeded here** —
 * `006_create_dispatch_channel_config.ts` already inserts exactly the one `GLOBAL` row
 * `01-DATABASE.md` §5 asks for (`primary_channel='KAFKA', fallback_channel='REST'`) as part of
 * that table's own creation migration, confirmed by direct read. Re-inserting it here would
 * violate `uq_dcc_scope` on every `db:seed` after the very first run. This file's own name still
 * matches its actual content: every key it seeds below is a `dispatch.*`-prefixed `service_config`
 * knob (the outbox/retry-worker's own scheduling config), just not the `dispatch_channel_config`
 * table itself, which this task's own scope note conflated with these `service_config` keys but
 * which does not need any further seeding.
 */
const GLOBAL_CONFIG_VALUES: ReadonlyArray<{
  key: string;
  value: string;
  valueType: 'string' | 'int';
}> = [
  { key: 'dispatch.kafka.attemptsBeforeFallback', value: '3', valueType: 'int' },
  { key: 'dispatch.outbox.pollIntervalSeconds', value: '5', valueType: 'int' },
  { key: 'dispatch.retry.maxAttempts', value: '5', valueType: 'int' },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  for (const { key, value, valueType } of GLOBAL_CONFIG_VALUES) {
    // eslint-disable-next-line no-await-in-loop -- T-RR-046: a handful of sequential inserts in a
    // one-shot seed, same convention `015_seed_service_config_defaults.ts` already established.
    await context.query(
      `INSERT INTO reward_redemption.service_config
         (config_key, scope_level, scope_ref, config_value, value_type)
       VALUES (:key, 'GLOBAL', NULL, :value, :valueType);`,
      { type: QueryTypes.RAW, replacements: { key, value, valueType } },
    );
  }
}

export async function down({ context }: { context: Sequelize }): Promise<void> {
  for (const { key } of GLOBAL_CONFIG_VALUES) {
    // eslint-disable-next-line no-await-in-loop -- T-RR-046: symmetric with up(), see above.
    await context.query(
      `DELETE FROM reward_redemption.service_config
       WHERE config_key = :key AND scope_level = 'GLOBAL' AND scope_ref IS NULL;`,
      { type: QueryTypes.RAW, replacements: { key } },
    );
  }
}
