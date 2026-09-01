/**
 * T-PC-043. Concurrent Kafka + gRPC load: both transports driven at a moderate sustained rate
 * *at the same time*, against the one shared HTTP `AppModule` process's own `OutboxPublisherWorker`
 * and the one shared real Postgres 16 server (root `CLAUDE.md`) both transports' processes connect
 * to — this task's own implementation note 2: "a real production instant of this service could
 * see both transports loaded simultaneously... more representative than two isolated
 * single-transport runs... should surface any resource contention between the Kafka consumer and
 * the gRPC server sharing the same process/DB pool." TC-3
 * (`promo-code-service-plan/tasks/T-PC-043-load-test-handover.md`).
 *
 * Compares each transport's own concurrent-run latency/error profile against
 * `kafka-load.e2e-spec.ts`/`grpc-load.e2e-spec.ts`'s own **documented, comparable-rate** solo
 * baseline (the "low"/"mid" steps of each, not the intentionally-over-capacity "high" step) —
 * TC-3's own expected outcome is "neither transport's latency degrades *sharply* due to the
 * other's load", which only means something relative to a known solo number, not in isolation.
 */
import 'reflect-metadata';
import {
  LoadTestHarness,
  runGrpcLoadStep,
  runKafkaLoadStep,
  type GrpcStepResult,
  type KafkaStepResult,
} from './support/load-test-harness';

jest.setTimeout(180_000);

// This suite's own solo baselines, run once up front against the *same* harness instance and
// rate/duration the concurrent step below uses — a same-run, same-machine baseline is a fairer
// comparison than reusing `kafka-load.e2e-spec.ts`/`grpc-load.e2e-spec.ts`'s own numbers from a
// separate Jest worker/process on a potentially different, noisier machine moment.
const KAFKA_RATE_PER_SEC = 15;
const GRPC_RATE_PER_SEC = 30;
const DURATION_SEC = 10;

describe('T-PC-043 — concurrent Kafka + gRPC load (real Redpanda, real mTLS, real Postgres) (e2e)', () => {
  let harness: LoadTestHarness;

  beforeAll(async () => {
    harness = await LoadTestHarness.create();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  // TC-3.
  it('TC-3: Kafka and gRPC driven concurrently — neither transport starves the other', async () => {
    // Solo baselines first, sequentially, each at the same rate/duration TC-3 itself uses.
    const kafkaSolo = await runKafkaLoadStep(harness, 'solo', KAFKA_RATE_PER_SEC, DURATION_SEC);
    // `code_prefix` is `varchar(10)` (`01-DATABASE.md` §1) — kept short here for the same reason
    // `runKafkaLoadStep`'s own header now documents.
    const { tenantId, bindRefId } = await harness.seedBoundConfig('GRL-S-');
    const grpcClient = harness.allowedGrpcClient();
    const grpcSolo = await runGrpcLoadStep(
      grpcClient,
      tenantId,
      bindRefId,
      'solo',
      GRPC_RATE_PER_SEC,
      DURATION_SEC,
    );

    // Concurrent step: both transports driven at the same rates, at the same time, against the
    // one shared harness — `Promise.all`, not sequential, is the entire point of this test.
    const concurrentGrpcFixture = await harness.seedBoundConfig('GRL-C-');
    const [kafkaConcurrent, grpcConcurrent]: [KafkaStepResult, GrpcStepResult] = await Promise.all([
      runKafkaLoadStep(harness, 'concurrent', KAFKA_RATE_PER_SEC, DURATION_SEC),
      runGrpcLoadStep(
        grpcClient,
        concurrentGrpcFixture.tenantId,
        concurrentGrpcFixture.bindRefId,
        'concurrent',
        GRPC_RATE_PER_SEC,
        DURATION_SEC,
      ),
    ]);
    grpcClient.close();

    // `console.warn` — this task's own load-test evidence, pasted into
    // `T-PC-043-load-test-results.md` verbatim (this project's ESLint config only allows
    // `console.warn`/`console.error`, `.eslintrc.js`).
    console.warn(
      'T-PC-043 concurrent-load TC-3 results:',
      JSON.stringify({ kafkaSolo, grpcSolo, kafkaConcurrent, grpcConcurrent }, null, 2),
    );

    // Neither transport loses/misroutes a request just because the other one is running at the
    // same time.
    expect(
      kafkaConcurrent.succeeded + kafkaConcurrent.failedBusiness + kafkaConcurrent.unresolved,
    ).toBe(kafkaConcurrent.attempted);
    expect(kafkaConcurrent.failedBusiness).toBe(0);
    expect(kafkaConcurrent.unresolved).toBe(0);
    expect(
      grpcConcurrent.succeeded + grpcConcurrent.failedBusiness + grpcConcurrent.transportErrors,
    ).toBe(grpcConcurrent.attempted);
    expect(grpcConcurrent.failedBusiness).toBe(0);
    expect(grpcConcurrent.transportErrors).toBe(0);

    // "Sharply" is this test's own operative word (implementation note 2/TC-3's own expected
    // outcome) — a generous 3x multiplier on the solo baseline's own p99, not equality, since
    // some contention on the shared DB pool/broker is expected and acceptable; only a *severe*
    // regression (one transport effectively starved by the other) should fail this test.
    if (kafkaSolo.latency.p99Ms > 0) {
      expect(kafkaConcurrent.latency.p99Ms).toBeLessThanOrEqual(kafkaSolo.latency.p99Ms * 3);
    }
    if (grpcSolo.latency.p99Ms > 0) {
      expect(grpcConcurrent.latency.p99Ms).toBeLessThanOrEqual(grpcSolo.latency.p99Ms * 3);
    }
  });
});
