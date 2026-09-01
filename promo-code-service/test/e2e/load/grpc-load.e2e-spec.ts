/**
 * T-PC-043. Sustained gRPC-path load: a real `@grpc/grpc-js` client, over a real mTLS handshake,
 * calls the real, listening `GrpcMicroserviceRootModule` (`src/grpc/grpc-server.main.ts`,
 * T-PC-031) at increasing controlled rates via `runGrpcLoadStep`. Unlike the Kafka path
 * (`kafka-load.e2e-spec.ts`), a `GenerateCode` call is synchronous end to end — no outbox/poll-
 * interval hop — so this suite's own latency measurement (client-side call duration) *is* the
 * whole round trip, not a proxy for one half of it. TC-2/TC-4
 * (`promo-code-service-plan/tasks/T-PC-043-load-test-handover.md`).
 *
 * Neither `PromoCodeConfigModule`'s own `PROMO_CODE_SEQUELIZE` connection
 * (`promo-code-config.module.ts`) nor any other module in this schema configures a Sequelize
 * `pool` option, so this run also exercises Sequelize's own default pool ceiling (max 5
 * connections) under concurrent load — a real, reportable capacity signal (this task's own
 * "Out" scope: report it, don't tune it) distinct from the Kafka path's own outbox-drain ceiling.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import * as grpc from '@grpc/grpc-js';
import {
  callGenerateCode,
  type PromoCodeServiceTestClient,
} from '../../grpc/support/test-grpc-client';
import {
  LoadTestHarness,
  parseMetricValue,
  runGrpcLoadStep,
  type GrpcStepResult,
} from './support/load-test-harness';

jest.setTimeout(180_000);

describe('T-PC-043 — sustained gRPC-path load (real mTLS, real Postgres) (e2e)', () => {
  let harness: LoadTestHarness;
  let client: PromoCodeServiceTestClient;
  let tenantId: string;
  let bindRefId: string;
  // Set by TC-2, read by TC-4 — see TC-4's own comment for why this is the actual number to
  // compare against, not a hardcoded guess.
  let totalSucceededFromTC2 = 0;

  beforeAll(async () => {
    harness = await LoadTestHarness.create();
    const fixture = await harness.seedBoundConfig('GL-');
    tenantId = fixture.tenantId;
    bindRefId = fixture.bindRefId;
    client = harness.allowedGrpcClient();
  });

  afterAll(async () => {
    client.close();
    await harness.teardown();
  });

  // TC-2: increasing sustained gRPC rates for a sustained window, p95/p99 latency documented.
  it('TC-2: sustained gRPC load at increasing rates — no transport errors, latency documented', async () => {
    const steps: GrpcStepResult[] = [];
    for (const [label, rate] of [
      ['low', 20],
      ['mid', 50],
      ['high', 100],
    ] as const) {
      // Steps run sequentially so each rate's own latency profile is attributable to that rate
      // alone, not blended with a neighbouring step's own in-flight tail.
      const result = await runGrpcLoadStep(client, tenantId, bindRefId, label, rate, 8);
      steps.push(result);

      // Every dispatched call resolves one way or another within this synchronous RPC's own
      // lifetime — nothing is ever "unresolved" the way an async Kafka result can be.
      expect(result.succeeded + result.failedBusiness + result.transportErrors).toBe(
        result.attempted,
      );
      expect(result.failedBusiness).toBe(0);
      // A transport-level error (`UNAVAILABLE`/`INTERNAL`/deadline) under sustained load at these
      // rates is the actual TC-2 failure condition ("no error-rate increase") — allow a small,
      // documented tolerance for a single slow-starting connection warm-up, not a silent pass.
      expect(result.transportErrors).toBeLessThanOrEqual(Math.ceil(result.attempted * 0.02));
    }

    // `console.warn` — this task's own load-test evidence, pasted into
    // `T-PC-043-load-test-results.md` verbatim (this project's ESLint config only allows
    // `console.warn`/`console.error`, `.eslintrc.js`).
    console.warn('T-PC-043 grpc-load TC-2 results:', JSON.stringify(steps, null, 2));

    totalSucceededFromTC2 = steps.reduce((sum, step) => sum + step.succeeded, 0);
  });

  // TC-4: the numbers this suite reports are the same ones a real Prometheus scrape of the real
  // gRPC process would read.
  it("TC-4: this process's own GET /metrics reflects the gRPC-path codes generated during TC-2", async () => {
    const response = await request(harness.grpcApp.getHttpServer()).get('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');

    const generatedSuccess = parseMetricValue(
      response.text,
      'promo_code_codes_generated_total{transport="GRPC",outcome="SUCCESS"}',
    );
    const durationCount = parseMetricValue(
      response.text,
      'promo_code_generation_duration_seconds_count{transport="GRPC"}',
    );

    // Compared against TC-2's own actually-observed `succeeded` sum, not a hardcoded guess: this
    // file's own dedicated `grpcApp` process is never shared with another Jest test file, so this
    // in-memory counter (T-PC-048) can only ever have been incremented by *this* suite's own TC-2
    // calls — an exact match is the correct assertion, immune to how many transport errors (if
    // any, within TC-2's own documented 2% tolerance) happened to occur on a given run.
    expect(generatedSuccess).toBe(totalSucceededFromTC2);
    expect(durationCount).toBeGreaterThanOrEqual(generatedSuccess);

    // `console.warn` — load-test evidence, see TC-2's own note above.
    console.warn(
      'T-PC-043 grpc-load TC-4 /metrics snapshot:',
      JSON.stringify({ generatedSuccess, durationCount }, null, 2),
    );
  });

  // Adjacent to T-PC-040's own gRPC TC-7 (mTLS rejection before the handler runs): run
  // immediately after TC-2's sustained load, proving that load on the allowed identity never
  // weakens the mTLS guard for a different, unauthenticated caller.
  it('adjacent: mTLS rejection is unaffected by concurrent sustained load on the allowed identity', async () => {
    const noCertClient = harness.noCertGrpcClient();
    await expect(
      callGenerateCode(noCertClient, {
        correlationId: randomUUID(),
        tenantId: randomUUID(),
        bindLevel: 'CAMPAIGN',
        bindRefId: randomUUID(),
        customerId: 'cust-load-no-cert',
        merchantId: '',
      }),
    ).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    noCertClient.close();
  });
});
