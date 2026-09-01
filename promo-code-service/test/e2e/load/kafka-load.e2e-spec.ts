/**
 * T-PC-043. Sustained Kafka-path load: a real `kafkajs` producer publishes real
 * `promo-code.generate.requested.v1` messages onto the real Redpanda broker at increasing
 * controlled rates; the real, listening `GenerateRequestedConsumer` (T-PC-030) processes each one
 * through the real `PromoCodeGenerationService` (T-PC-021); the real `OutboxPublisherWorker`
 * (T-PC-022), running with its own real `setInterval` poller (not manually pumped — see
 * `support/load-test-harness.ts`'s own header), publishes the result onto
 * `promo-code.generate.result.v1`, observed by `runKafkaLoadStep`'s own dedicated consumer, which
 * timestamps each arrival against this test's own publish timestamp. TC-1/TC-4
 * (`promo-code-service-plan/tasks/T-PC-043-load-test-handover.md`).
 *
 * The rate ladder below (10 -> 25 -> 45 msg/s) is chosen to straddle this service's own documented
 * default outbox drain capacity — `DEFAULT_OUTBOX_POLL_INTERVAL_MS` (500ms) x
 * `DEFAULT_OUTBOX_BATCH_SIZE` (20) = ~40 rows/sec (`outbox-publisher.config.ts`) — specifically so
 * this run can report an honest number instead of a pre-decided one (`AGENT-PROTOCOL.md` §3,
 * this task's own implementation note 1): a step comfortably under ~40/s should show a bounded,
 * quickly-draining backlog; a step at/above it should show the backlog grow during the step and
 * only then drain, a real (and, per this task's own "Out" scope, *not fixed here*) capacity
 * signal worth reporting to the receiving team as a config-tuning lever, not a defect.
 *
 * **Requires a running Redpanda** (`docker compose up -d redpanda` from `promo-code-service/`) and
 * the real local Postgres 16 server (root `CLAUDE.md`).
 *
 * **Run with `npx jest --runInBand test/e2e/load` (or alongside `test/e2e test/security`,
 * T-PC-040's own established convention) for reliable results.** `GENERATE_REQUESTED_CONSUMER_
 * GROUP` (`kafka-consumer.config.ts`) is a fixed name shared by every `*.e2e-spec.ts` file that
 * boots a `GenerateRequestedConsumer` — an already-disclosed, pre-existing characteristic
 * (T-PC-040's own completion report), not introduced by this task. Under full parallel `npm
 * test`, a message this suite publishes can be load-balanced by the real broker to a *different*
 * Jest worker's own separate consumer instance — TC-1 still eventually observes the correct
 * result (see that test's own comments), but TC-4's in-process metrics counter can then
 * legitimately undercount relative to what TC-1 itself observed. See TC-4's own comment for the
 * full mechanism.
 */
import 'reflect-metadata';
import request from 'supertest';
import {
  LoadTestHarness,
  parseMetricValue,
  runKafkaLoadStep,
  type KafkaStepResult,
} from './support/load-test-harness';

jest.setTimeout(240_000);

describe('T-PC-043 — sustained Kafka-path load (real Redpanda, real Postgres) (e2e)', () => {
  let harness: LoadTestHarness;
  // Set by TC-1, read by TC-4 — see TC-4's own comment for why this is the actual number to
  // compare against, not a hardcoded guess.
  let totalSucceededFromTC1 = 0;

  beforeAll(async () => {
    harness = await LoadTestHarness.create();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  // TC-1: increasing sustained Kafka rates for a sustained window.
  it('TC-1: sustained Kafka load at increasing rates — no lost/failed requests, bounded outbox backlog', async () => {
    const steps: KafkaStepResult[] = [];
    for (const [label, rate] of [
      ['low', 10],
      ['mid', 25],
      ['high', 45],
    ] as const) {
      // Steps run sequentially, not `Promise.all`-parallel: each step's own sustained-rate
      // finding depends on the previous step's outbox backlog having already been observed and
      // (mostly) drained, not overlapping with the next step's own arrivals.
      const result = await runKafkaLoadStep(harness, label, rate, 10);
      steps.push(result);

      // No request is ever silently lost: every published message either produced a result this
      // step's own consumer observed, or is still `unresolved` (only expected/tolerated at the
      // intentionally-over-capacity "high" step — see this file's own header).
      expect(result.succeeded + result.failedBusiness + result.unresolved).toBe(result.attempted);
      // Every request that *did* resolve within this test's own bounded tail window resolved as a
      // genuine business SUCCESS, never a `CONFIG_NOT_BOUND`/`GENERATION_EXHAUSTED`-class failure —
      // this fixture's own config is always bound and active.
      expect(result.failedBusiness).toBe(0);
    }

    // `console.warn` (not `.log` — this project's ESLint config only allows `warn`/`error`,
    // `.eslintrc.js`): this task's own load-test evidence, meant to be pasted into
    // `T-PC-043-load-test-results.md` verbatim, not summarised.
    console.warn('T-PC-043 kafka-load TC-1 results:', JSON.stringify(steps, null, 2));

    const lowAndMid = steps.filter((s) => s.label !== 'high');
    for (const step of lowAndMid) {
      // The documented-sustained-rate claim itself: at a rate at/under the outbox's own default
      // drain capacity, the backlog *this step's own tenant* created is fully gone well within
      // the tail budget, not just "eventually" — `outboxPendingAfterDrain` (`countTenantOutbox
      // Pending`, scoped to this step's own fresh `tenantId`, not the global `/metrics` gauge —
      // see that function's own header for why: this project's own full, parallel `npm test` has
      // every other `*.e2e-spec.ts` writing real rows into the same shared `promo_code_outbox`
      // table at the same time, and the global gauge cannot be attributed to just this step) is
      // captured only once `publishedAt` is already empty (every result observed), so any
      // remaining scoped-pending count here means *this* step's own rows are still pending
      // despite every result already having been published.
      expect(step.outboxPendingAfterDrain).toBeLessThanOrEqual(step.outboxPendingAtStepStart + 2);
    }

    // The intentionally-over-capacity step is the real finding this test exists to produce: the
    // backlog it creates is *bounded* (this run's own tail budget above is generous enough to
    // drain it, `unresolved` came back to 0 or close to it) rather than growing without limit —
    // TC-1's own expected outcome ("does not grow unboundedly"), not that it stayed at the low
    // step's own latency/backlog profile.
    const high = steps.find((s) => s.label === 'high');
    expect(high).toBeDefined();
    expect(high!.unresolved).toBeLessThanOrEqual(Math.ceil(high!.attempted * 0.1));

    totalSucceededFromTC1 = steps.reduce((sum, step) => sum + step.succeeded, 0);
  });

  // TC-4: the numbers this suite reports are the same ones a real Prometheus scrape of the real
  // Kafka consumer process would read — not a parallel, potentially-drifting measurement.
  it("TC-4: this process's own GET /metrics reflects the Kafka-path codes generated during TC-1", async () => {
    const response = await request(harness.kafkaApp.getHttpServer()).get('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');

    const generatedSuccess = parseMetricValue(
      response.text,
      'promo_code_codes_generated_total{transport="KAFKA",outcome="SUCCESS"}',
    );
    const durationCount = parseMetricValue(
      response.text,
      'promo_code_generation_duration_seconds_count{transport="KAFKA"}',
    );

    // Compared against TC-1's own actually-observed `succeeded` sum, not a hardcoded guess at an
    // expected rate — reliable under this suite's own recommended isolated invocation
    // (`npx jest --runInBand test/e2e/load`, this file's own header), where this file's own
    // dedicated `kafkaApp` process is the only member of `GENERATE_REQUESTED_CONSUMER_GROUP`
    // (`kafka-consumer.config.ts`) and so the only process that could have incremented this
    // in-memory counter for the messages TC-1 published.
    //
    // **Known, already-disclosed limitation under plain full-parallel `npm test`** (not
    // introduced by this task): `GENERATE_REQUESTED_CONSUMER_GROUP` is a fixed name shared by
    // *every* `*.e2e-spec.ts` file that boots a `GenerateRequestedConsumer` — T-PC-040's own
    // completion report already flagged this exact characteristic for `test/e2e/**`
    // ("a fixed name shared by every harness instance across every e2e/security spec file...
    // this suite... should be run with `--runInBand`"). Under full parallel `npm test`, a message
    // this test publishes can be load-balanced by the real broker to a *different* Jest worker's
    // own separate `GenerateRequestedConsumer` instance (a different OS process, a different
    // in-memory `MetricsService`) — TC-1 still eventually observes the correct result (the
    // resulting `promo_code_outbox` row is published by whichever process's own poller reaches it
    // in the one shared real Postgres database), but *this* process's own `codes_generated_total`
    // may then undercount relative to `totalSucceededFromTC1`. Fixing the root cause (a
    // test-instance-unique consumer group id) means editing `kafka-consumer.config.ts`, owned by
    // `agent-promo-messaging` (R8) — not this task's file to change, and not a new, unfiled
    // defect (T-PC-040's own report already named it and flagged the permanent fix as a
    // `package.json`/Jest-config follow-up outside any single agent's own scope).
    expect(generatedSuccess).toBe(totalSucceededFromTC1);
    expect(durationCount).toBeGreaterThanOrEqual(generatedSuccess);

    // `console.warn` — load-test evidence, see TC-1's own note above.
    console.warn(
      'T-PC-043 kafka-load TC-4 /metrics snapshot:',
      JSON.stringify({ generatedSuccess, durationCount }, null, 2),
    );
  });
});
