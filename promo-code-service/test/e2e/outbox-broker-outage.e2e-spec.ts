/**
 * T-PC-040. TC-6 / gate `G2`'s own "outbox never loses a result across a broker outage" criteria,
 * proven here at the full-system level with a real broker actually going down and coming back up
 * (already unit-tested with a mocked producer in `test/modules/outbox/outbox-publisher.worker.spec.ts`,
 * T-PC-022) — `AGENT-PROTOCOL.md` §3: only a real broker outage can prove this, not a mock that
 * agrees with itself about what "unreachable" means.
 *
 * ### Why this test drives `OutboxPublisherWorker.runOnce()` manually instead of racing its own
 * `setInterval`
 *
 * The harness never auto-starts the outbox worker (`OUTBOX_PUBLISHER_AUTOSTART` stays at its own
 * `NODE_ENV=test` default — see `test/e2e/setup/e2e-test-app.ts`'s header). That is what makes
 * this test's own sequencing deterministic *in isolation*: nothing in this test's own process
 * calls `runOnce()` for this row until this test chooses to, so the row is guaranteed `PENDING`
 * at that point as far as this file's own code is concerned.
 *
 * ### A note on blast radius (flagged, not silently worked around — and confirmed, not just a
 * theoretical risk)
 *
 * `OutboxRepository.findPendingBatch()` (T-PC-022, outside this task's file scope) is a
 * deliberately global, unscoped query by that task's own design ("no `JOIN`, no extra predicate
 * here... risk losing that plan") — it fetches *any* `PENDING` row in the whole
 * `promo_code_outbox` table, not just rows a given test created. That means **any** other
 * concurrently-running process that calls `runOnce()` against the same real Postgres database —
 * including `kafka-round-trip.e2e-spec.ts`/`cross-transport-parity.e2e-spec.ts`'s own
 * `withOutboxPump` helper, running in a different Jest worker process under a full parallel
 * `npm test` — can and (confirmed during this task's own verification pass, not just
 * hypothesised) *does* occasionally publish this test's row before this test's own `pollUntil`
 * observes it as `PENDING`, since nothing scopes that query to "rows this test created." This is
 * the one race this suite cannot fully close from `test/e2e/**` alone — the fix belongs in
 * `OutboxRepository` (add tenant/row scoping, or a claim/lock step), which is `agent-promo-generation`'s
 * owned file, not this agent's (R8). Recorded here and in this task's completion report rather
 * than silently hidden, per `AGENT-PROTOCOL.md` §3 ("flag the flaw... let the architect decide").
 *
 * Separately, this is also the one spec in this suite that stops/starts the single, shared local
 * Redpanda container (`docker-compose.yml`, T-PC-001) — every other spec here assumes that broker
 * stays up for its own real-broker round trip; the outage window is kept as short as physically
 * possible to minimise that overlap, but Jest's default multi-worker scheduling does not guarantee
 * isolation between files either way.
 *
 * **Given both of the above, this spec (and ideally this whole `test/e2e/**` directory) should be
 * run with `--runInBand`** (`npx jest --runInBand test/e2e`) for a fully reliable result — verified
 * repeatedly clean under that invocation during this task's own verification pass (including three
 * consecutive full-suite runs, TC-10). A permanent fix for the plain, literal `npm test` gate (a
 * dedicated, serialised Jest project for `test/e2e/**`) needs a `package.json`/Jest-config change
 * outside this agent's own file scope (`project.config.json` grants `package.json` only to
 * `agent-promo-foundation`) — flagged as a follow-up, not implemented here.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { GENERATE_REQUESTED_TOPIC } from '@/messaging/kafka-consumer.config';
import { GENERATE_RESULT_TOPIC } from '@/modules/generation/promo-code-generation.constants';
import {
  startRedpandaBroker,
  stopRedpandaBroker,
  waitForRedpandaReady,
} from './setup/testcontainers.config';
import { E2ETestHarness, pollUntil, waitForKafkaMessage } from './setup/e2e-test-app';

jest.setTimeout(90_000);

interface OutboxRow {
  id: string;
  status: string;
  attempts: number;
}

describe('T-PC-040 — outbox publish survives a real broker outage (gate G2) (e2e)', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await E2ETestHarness.create();
  });

  afterAll(async () => {
    // Belt-and-braces: guarantee the shared broker is left running for every other suite,
    // regardless of how this test's own body exits.
    await startRedpandaBroker().catch(() => undefined);
    await waitForRedpandaReady(30_000).catch(() => undefined);
    await harness.teardown();
  });

  async function findOutboxRow(tenantId: string, correlationId: string): Promise<OutboxRow | null> {
    const rows = await harness.sequelize.query<OutboxRow>(
      `SELECT o.id, o.status, o.attempts
         FROM promo_code.promo_code_outbox o
         JOIN promo_code.promo_code p ON p.id = o.promo_code_id
        WHERE p.tenant_id = :tenantId AND p.correlation_id = :correlationId`,
      { type: QueryTypes.SELECT, replacements: { tenantId, correlationId } },
    );
    return rows[0] ?? null;
  }

  // TC-6
  it('TC-6: a promo_code_outbox row committed while the broker is up survives a stop/restart and eventually publishes', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'OUTAGE-' });
    const correlationId = randomUUID();

    // 1. Broker is up. Publish through the real Kafka consumer path so the row is created exactly
    //    the way production creates it (T-PC-030 -> T-PC-021's transactional insert), not a direct
    //    domain-service call bypassing the transport this task is meant to exercise end to end.
    await harness.publishGenerateRequested(GENERATE_REQUESTED_TOPIC, correlationId, tenantId, {
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-outage-tc6',
      merchantId: null,
      activityContext: null,
    });

    const committedRow = await pollUntil(() => findOutboxRow(tenantId, correlationId), 20_000);
    expect(committedRow.status).toBe('PENDING');
    const attemptsBeforeOutage = committedRow.attempts;

    // 1b. The row this test cares about from here on is already committed — this test's own
    //     `GenerateRequestedConsumer` (long-lived across the whole file, per-file `beforeAll`) has
    //     no further part to play. Stop it *before* the outage rather than leaving a real consumer
    //     group's heartbeat/session connected through a live broker stop/restart: this keeps the
    //     rest of the test's Kafka clients (the outbox worker's own producer, and the ad hoc reader
    //     `waitForKafkaMessage` opens afterwards) the only ones that ever have to deal with the
    //     broker being down, each doing so from a clean, not-yet-connected state rather than an
    //     established connection recovering mid-flight — avoiding a real kafkajs stray-socket race
    //     this suite hit during development (a lingering `ESTABLISHED` connection to the broker
    //     after `afterAll`, `lsof`-confirmed) rather than merely papering over it with a longer wait.
    await harness.kafkaConsumer.stop();

    // 2. Stop the broker — the row above is confirmed PENDING and nothing has attempted to
    //    publish it yet (autostart is off; see this file's own header).
    await stopRedpandaBroker();
    try {
      // 3. A publish attempt while the broker is down must fail — proving the row genuinely could
      //    not have published during this window, not that this test merely assumes so.
      await harness.outboxWorker.runOnce();

      const rowDuringOutage = await findOutboxRow(tenantId, correlationId);
      expect(rowDuringOutage).not.toBeNull();
      expect(rowDuringOutage?.status).toBe('PENDING');
      expect(rowDuringOutage?.attempts).toBeGreaterThan(attemptsBeforeOutage);
    } finally {
      // 4. Restart the broker as promptly as possible, whatever the assertions above did.
      await startRedpandaBroker();
      await waitForRedpandaReady(30_000);
    }

    // 5. Once the broker is back, draining resumes and the row is eventually PUBLISHED — no data
    //    loss across the outage (gate G2). Driven by explicit `runOnce()` calls, same
    //    deterministic-polling discipline as the rest of this suite.
    const publishedRow = await pollUntil(async () => {
      await harness.outboxWorker.runOnce();
      const row = await findOutboxRow(tenantId, correlationId);
      return row && row.status === 'PUBLISHED' ? row : null;
    }, 30_000);
    expect(publishedRow.status).toBe('PUBLISHED');

    // 6. The real result message actually arrives on the real topic — the end-to-end guarantee
    //    this gate exists to protect, not just an internal status column flip.
    const resultMessage = await waitForKafkaMessage(
      GENERATE_RESULT_TOPIC,
      30_000,
      (key) => key === correlationId,
    );
    const data = resultMessage.data as Record<string, unknown>;
    expect(data.status).toBe('SUCCESS');
    expect((data.code as string).startsWith('OUTAGE-')).toBe(true);
  });
});
