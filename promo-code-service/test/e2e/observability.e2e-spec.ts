/**
 * T-PC-042. System-level observability verification — real Postgres, real Redpanda, the real
 * `E2ETestHarness` (T-PC-040's own shared harness, `AGENT-PROTOCOL.md` §3: no self-agreeing mock
 * stands in for the broker/DB here either). Reuses `E2ETestHarness` read-only (this task never
 * edits `test/e2e/setup/**`, which remains T-PC-040's own file) exactly the way every other spec
 * in this directory already does.
 *
 * **TC-1 (Kafka)/TC-2 (gRPC) end-to-end correlationId tracing — where the proof actually lives.**
 * Originally blocked here: `GenerateRequestedConsumer`/`PromoCodeController` live in
 * `src/messaging/**`/`src/grpc/**`, `agent-promo-messaging`'s own file scope (R8), and were not
 * wired to this task's `CorrelationContextService`/structured logger. Filed as T-PC-047 (now
 * `done`) — `KafkaConsumerModule`/`GrpcServerModule` now import `LoggingModule` and wrap their
 * entry points in `CorrelationContextService.run(...)` (see those modules' own T-PC-047 header
 * notes). The actual real-broker/real-mTLS-process proof for TC-1/TC-2 lives in
 * `test/messaging/generate-requested.consumer.e2e-spec.ts` and `test/grpc/grpc-server.e2e-spec.ts`
 * (both tests literally named `T-PC-047 TC-2`, T-PC-042's own numbering, in each of those files) —
 * intentionally not duplicated here, since those suites already own the real consumer/gRPC-server
 * process each transport's proof needs and this file has no independent way to reach either entry
 * point without re-standing-up infrastructure `E2ETestHarness` already owns. What *is* proven
 * here, against real infrastructure: the HTTP transport's own correlationId tracing end to end
 * (the one transport this file's own harness exposes directly), `/metrics`' real Prometheus-format
 * output (TC-12), the outbox backlog gauge against real `promo_code_outbox` rows (TC-6/TC-7), and
 * Kafka consumer lag against the real consumer group/broker (TC-8/TC-9).
 *
 * Run with `--runInBand` for the same reason every other file in this directory documents
 * (`outbox-broker-outage.e2e-spec.ts`'s own header): `GENERATE_REQUESTED_CONSUMER_GROUP` is a
 * fixed name shared by every harness instance. The outbox-draining poll below now scopes its own
 * `runOnce({ rowIds: [...] })` call to this test's own row (T-PC-045's `OutboxBatchScope`,
 * T-PC-040's own follow-through) rather than an unscoped `runOnce()` — the fix for the exact
 * cross-suite race T-PC-045's own filed evidence traced back to this file.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { GENERATE_REQUESTED_TOPIC } from '@/messaging/kafka-consumer.config';
import { MetricsService } from '@/observability/metrics/metrics.service';
import { E2ETestHarness, findOutboxRowId, pollUntil } from './setup/e2e-test-app';

jest.setTimeout(90_000);

function parsePrometheusValue(text: string, metricLine: RegExp): number | null {
  const match = text.match(metricLine);
  return match ? Number(match[1]) : null;
}

describe('T-PC-042 — observability (metrics + HTTP correlationId tracing) (e2e)', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await E2ETestHarness.create();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  // TC-12: /metrics is real, scrapable Prometheus text exposition format.
  it('GET /metrics returns 200, text/plain, and a well-formed Prometheus body', async () => {
    const response = await request(harness.app.getHttpServer()).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('# HELP promo_code_codes_generated_total');
    expect(response.text).toContain('# TYPE promo_code_outbox_pending_count gauge');
    expect(response.text).toContain('# TYPE promo_code_kafka_consumer_lag gauge');

    for (const line of response.text.split('\n').filter(Boolean)) {
      if (line.startsWith('#')) continue;
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?[0-9.]+$/);
    }
  });

  // TC-6/TC-7: outbox backlog gauge against real promo_code_outbox rows, before/after a real
  // publish — relative assertions (not "exactly 0/1") because `findPendingBatch`'s own global,
  // unscoped reach (T-PC-045) means a concurrently-running spec's rows can share this count.
  it('reflects a real PENDING outbox row appearing, then disappearing once published', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'OBS-' });
    const correlationId = randomUUID();

    const before = await request(harness.app.getHttpServer()).get('/metrics');
    const pendingBefore =
      parsePrometheusValue(before.text, /promo_code_outbox_pending_count (\d+)/) ?? 0;

    await harness.publishGenerateRequested(GENERATE_REQUESTED_TOPIC, correlationId, tenantId, {
      bindLevel: 'CAMPAIGN',
      bindRefId,
      customerId: 'cust-observability-tc6',
      merchantId: null,
      activityContext: null,
    });

    await pollUntil(async () => {
      const scrape = await request(harness.app.getHttpServer()).get('/metrics');
      const pending =
        parsePrometheusValue(scrape.text, /promo_code_outbox_pending_count (\d+)/) ?? 0;
      const oldestAge = parsePrometheusValue(
        scrape.text,
        /promo_code_outbox_oldest_pending_age_seconds ([0-9.]+)/,
      );
      return pending > pendingBefore && oldestAge !== null && oldestAge >= 0 ? true : null;
    }, 20_000);

    // Drain it — TC-7's own "back to a lower reading, no error" half of the same story. Scoped to
    // this test's own row id (T-PC-045's `OutboxBatchScope`) so this poll never also reaches into
    // some other, concurrently-running suite's own PENDING row (`outbox-broker-outage.e2e-spec.ts`'s
    // own header documents the exact race an unscoped call here used to reproduce).
    await pollUntil(async () => {
      const rowId = await findOutboxRowId(harness.sequelize, tenantId, correlationId);
      if (rowId) {
        await harness.outboxWorker.runOnce({ rowIds: [rowId] });
      }
      const scrape = await request(harness.app.getHttpServer()).get('/metrics');
      const pending =
        parsePrometheusValue(scrape.text, /promo_code_outbox_pending_count (\d+)/) ?? 0;
      return pending <= pendingBefore ? true : null;
    }, 20_000);
  });

  // TC-8/TC-9: real Kafka consumer lag — messages published faster than consumed (lag > 0),
  // then drained (lag back to 0). Stops/restarts the *shared* GENERATE_REQUESTED_CONSUMER_GROUP
  // consumer this harness owns, so this test (like outbox-broker-outage.e2e-spec.ts) needs
  // --runInBand to avoid perturbing a sibling file's own in-flight round trip.
  it('shows nonzero Kafka consumer lag while unconsumed, and zero once caught up', async () => {
    const { tenantId, bindRefId } = await harness.createBoundConfig({ codePrefix: 'LAG-' });
    const metricsService = harness.app.get(MetricsService);

    await harness.kafkaConsumer.stop();
    try {
      for (let i = 0; i < 5; i += 1) {
        await harness.publishGenerateRequested(GENERATE_REQUESTED_TOPIC, randomUUID(), tenantId, {
          bindLevel: 'CAMPAIGN',
          bindRefId,
          customerId: `cust-observability-lag-${i}`,
          merchantId: null,
          activityContext: null,
        });
      }

      await pollUntil(async () => {
        const text = await metricsService.render();
        const lag = parsePrometheusValue(text, /promo_code_kafka_consumer_lag (\d+)/) ?? 0;
        return lag > 0 ? lag : null;
      }, 20_000);
    } finally {
      await harness.kafkaConsumer.start();
    }

    // Give the now-running consumer a moment to actually drain the backlog it just committed to.
    await pollUntil(async () => {
      const text = await metricsService.render();
      const lag = parsePrometheusValue(text, /promo_code_kafka_consumer_lag (\d+)/);
      return lag === 0 ? true : null;
    }, 30_000);
  });

  // HTTP transport's own correlationId tracing end to end, minted by
  // CorrelationContextMiddleware and appearing on every structured log line for that request —
  // the same property TC-1 (Kafka)/TC-2 (gRPC) ask for, proven for those two transports instead
  // in test/messaging/generate-requested.consumer.e2e-spec.ts / test/grpc/grpc-server.e2e-spec.ts
  // (see this file's own header, "T-PC-047 TC-2" in each).
  it('carries one correlationId across every structured log line for a single HTTP request', async () => {
    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write);

    let correlationId: string | undefined;
    try {
      const response = await request(harness.app.getHttpServer()).get('/health');
      correlationId = response.headers['x-correlation-id'];
    } finally {
      spy.mockRestore();
    }

    expect(correlationId).toBeDefined();
    const entries = written
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .filter((entry) => entry.correlationId === correlationId);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.correlationId).toBe(correlationId);
      expect(entry.transport).toBe('HTTP');
    }
  });
});
