/**
 * T-RR-021 — `CompletionSweepService`. Two describe blocks, same split as
 * `test/processing/claim-worker.service.spec.ts` (T-RR-020): fakes for the poll-loop's own
 * lifecycle/scheduling behavior, then the real repository/real-Postgres path for TC-8/TC-9
 * (this task's own verification step 2).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import { CompletionSweepService } from '@/modules/redemption/completion-sweep.service';
import { RedemptionStateMachineService } from '@/modules/redemption/redemption-state-machine.service';
import type { RedemptionCompletionSideEffectsPort } from '@/modules/redemption/redemption-completion-side-effects.port';
import type { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { MetricsRegistry } from '@/observability/metrics.registry';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';

/** Polls `predicate` with real timers until it's true or `timeoutMs` elapses — same idiom
 * `claim-worker.service.spec.ts` already established for this exact class of poll-loop test. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function realDbConfigService(): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
  } as Partial<Config>;
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

describe('T-RR-021 — CompletionSweepService (unit, fakes)', () => {
  let service: CompletionSweepService;
  let sweepOnceSpy: jest.SpyInstance;
  let resolveMock: jest.Mock;

  function build(intervalSeconds: number, opts: { rejectInterval?: boolean } = {}): void {
    resolveMock = jest.fn(async (key: string) => {
      if (key === 'completionSweep.intervalSeconds') {
        if (opts.rejectInterval) {
          throw new Error('simulated missing service_config seed row');
        }
        return intervalSeconds;
      }
      if (key === 'completionSweep.graceSeconds') {
        return 60;
      }
      throw new Error(`unexpected service_config key: ${key}`);
    });
    const fakeServiceConfig = {
      resolve: resolveMock,
    } as unknown as ServiceConfigResolverService;
    const fakeStateMachine = {} as unknown as RedemptionStateMachineService;
    const fakePool = {
      query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
      end: jest.fn(async () => undefined),
      // minimal fake satisfying only the `Pool` methods this service actually calls (same idiom
      // as every other repository's own fake-pool tests in this service).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    service = new CompletionSweepService(
      fakeStateMachine,
      fakeServiceConfig,
      new MetricsRegistry(),
      realDbConfigService(),
      fakePool,
    );
    sweepOnceSpy = jest.spyOn(service, 'sweepOnce').mockResolvedValue(undefined);
  }

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('calls sweepOnce repeatedly at the resolved interval', async () => {
    build(0.02); // 20ms
    service.onApplicationBootstrap();

    await waitFor(() => sweepOnceSpy.mock.calls.length >= 3);

    expect(sweepOnceSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(resolveMock).toHaveBeenCalledWith('completionSweep.intervalSeconds', 'int');
  });

  it('a rejected interval resolution does not crash the loop — logged, not thrown, and shutdown still completes promptly', async () => {
    build(0.02, { rejectInterval: true });
    service.onApplicationBootstrap();
    await waitFor(() => resolveMock.mock.calls.length >= 1);

    // sweepOnce is never reached for an iteration whose own interval resolution failed.
    expect(sweepOnceSpy).not.toHaveBeenCalled();

    // The loop must still be alive (not crashed) and stoppable: onModuleDestroy resolving
    // promptly (well under the 30s fallback-interval sleep) proves the in-flight sleep's own
    // stopSignal wakes it, exactly like ClaimWorkerService's own shutdown-latency guarantee.
    const start = Date.now();
    await service.onModuleDestroy();
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('onModuleDestroy stops the loop — no further sweepOnce calls once it resolves', async () => {
    build(0.01);
    service.onApplicationBootstrap();
    await waitFor(() => sweepOnceSpy.mock.calls.length >= 1);

    await service.onModuleDestroy();
    const countAtStop = sweepOnceSpy.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sweepOnceSpy.mock.calls.length).toBe(countAtStop);
  });

  it('a rejected sweepOnce does not crash the loop — it keeps polling after the interval', async () => {
    build(0.02);
    sweepOnceSpy.mockReset();
    sweepOnceSpy
      .mockRejectedValueOnce(new Error('simulated transient failure'))
      .mockResolvedValue(undefined);

    service.onApplicationBootstrap();

    await waitFor(() => sweepOnceSpy.mock.calls.length >= 2, 2000);
    expect(sweepOnceSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * T-RR-057 — `sweepOnce`'s own `reward_redemptions_completed_total` increment, exercised against a
 * fake `Pool`/fake state machine (not the poll loop, not real Postgres) so each case can control
 * exactly which rows the "stale" query returns and exactly how `completeDispatched` resolves.
 */
describe('T-RR-057 — CompletionSweepService.sweepOnce metrics (unit, fakes)', () => {
  let metrics: MetricsRegistry;

  function fakeServiceConfigForSweep(): ServiceConfigResolverService {
    return {
      resolve: jest.fn(async (key: string) => {
        if (key === 'completionSweep.graceSeconds') {
          return 60;
        }
        throw new Error(`unexpected service_config key: ${key}`);
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  function build(
    staleRows: Array<{ id: string; external_system_code: string | null }>,
    completeDispatched: jest.Mock,
  ): CompletionSweepService {
    metrics = new MetricsRegistry();
    const fakeStateMachine = { completeDispatched } as unknown as RedemptionStateMachineService;
    const fakePool = {
      query: jest.fn(async () => ({ rows: staleRows, rowCount: staleRows.length })),
      end: jest.fn(async () => undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return new CompletionSweepService(
      fakeStateMachine,
      fakeServiceConfigForSweep(),
      metrics,
      realDbConfigService(),
      fakePool,
    );
  }

  it("T-RR-057 TC-2: a successful completeDispatched increments reward_redemptions_completed_total{system_code} using the row's own external_system_code", async () => {
    const id = randomUUID();
    const completeDispatched = jest.fn().mockResolvedValue(undefined);
    const service = build([{ id, external_system_code: 'PROMO_CODE_SERVICE' }], completeDispatched);

    await service.sweepOnce();

    expect(completeDispatched).toHaveBeenCalledWith(id);
    expect(
      metrics.getCounterValue('reward_redemptions_completed_total', {
        system_code: 'PROMO_CODE_SERVICE',
      }),
    ).toBe(1);
  });

  it('T-RR-057 TC-3 (regression): a thrown completeDispatched never increments reward_redemptions_completed_total', async () => {
    const id = randomUUID();
    const completeDispatched = jest.fn().mockRejectedValue(new Error('simulated DB failure'));
    const service = build([{ id, external_system_code: 'PROMO_CODE_SERVICE' }], completeDispatched);

    // sweepOnce catches and logs per-row failures — it must not throw here (existing TC-8/TC-9
    // behaviour), but the counter must not have moved either.
    await expect(service.sweepOnce()).resolves.toBeUndefined();

    expect(metrics.getCounterValue('reward_redemptions_completed_total')).toBe(0);
  });

  it('T-RR-057 TC-4 (adjacent, defensive): a row with no external_system_code does not increment (and does not throw)', async () => {
    const id = randomUUID();
    const completeDispatched = jest.fn().mockResolvedValue(undefined);
    const service = build([{ id, external_system_code: null }], completeDispatched);

    await expect(service.sweepOnce()).resolves.toBeUndefined();

    expect(completeDispatched).toHaveBeenCalledWith(id);
    expect(metrics.getCounterValue('reward_redemptions_completed_total')).toBe(0);
  });

  it('multiple stale rows each increment their own system_code label independently', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const completeDispatched = jest.fn().mockResolvedValue(undefined);
    const service = build(
      [
        { id: idA, external_system_code: 'PROMO_CODE_SERVICE' },
        { id: idB, external_system_code: 'CORE_BANKING' },
      ],
      completeDispatched,
    );

    await service.sweepOnce();

    expect(
      metrics.getCounterValue('reward_redemptions_completed_total', {
        system_code: 'PROMO_CODE_SERVICE',
      }),
    ).toBe(1);
    expect(
      metrics.getCounterValue('reward_redemptions_completed_total', {
        system_code: 'CORE_BANKING',
      }),
    ).toBe(1);
  });
});

describe('T-RR-021 — CompletionSweepService (real Postgres, verification step 2)', () => {
  const TENANT_ID = 950_000 + Math.floor(Math.random() * 49_999);
  let migrationDb: Sequelize;
  let stateMachine: RedemptionStateMachineService;
  let sideEffects: RedemptionCompletionSideEffectsPort & {
    calls: RewardRedemptionEntryRow[];
  };
  let service: CompletionSweepService;
  let metrics: MetricsRegistry;

  function baseEntryFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: randomUUID(),
      correlation_id: randomUUID(),
      tenant_id: TENANT_ID,
      customer_id_encrypted: 'ciphertext-placeholder',
      customer_id_hash: `hash-${randomUUID()}`,
      customer_id_type: 'EMAIL',
      activity_performed_date: new Date(),
      activity_type: 'PURCHASE',
      activity_category: 'SPEND',
      activity_value: 10,
      activity_value_unit: 'USD',
      channel: 'WEB',
      activity_performed_env: 'PROD',
      activity_name: 't-rr-021 completion sweep fixture',
      campaign_code: 'CAMP1',
      tracker_code: 'TRK1',
      tracker_component_code: 'COMP1',
      reward_code: 'RWD1',
      reward_category: 'CASHBACK',
      reward_value: 5,
      reward_value_unit: 'USD',
      reward_entry_date: new Date(),
      completion_cycle: 1,
      reward_processed_env: 'development',
      ingestion_channel: 'REST',
      status: 'dispatched_external',
      external_system_code: 'PROMO_CODE_SERVICE',
      external_reference_id: `ext-ref-${randomUUID()}`,
      redeemed_at: new Date(),
      ...overrides,
    };
  }

  async function insertStaleDispatchedExternalRow(): Promise<string> {
    const f = baseEntryFields();
    const [row] = await migrationDb.query<{ id: string }>(
      `INSERT INTO reward_redemption.reward_redemption_entry
         (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
          activity_performed_date, activity_type, activity_category, activity_value,
          activity_value_unit, channel, activity_performed_env, activity_name, campaign_code,
          tracker_code, tracker_component_code, reward_code, reward_category, reward_value,
          reward_value_unit, reward_entry_date, completion_cycle, reward_processed_env,
          ingestion_channel, status, external_system_code, external_reference_id, redeemed_at,
          updated_at)
       VALUES
         (:id, :correlation_id, :tenant_id, :customer_id_encrypted, :customer_id_hash,
          :customer_id_type, :activity_performed_date, :activity_type, :activity_category,
          :activity_value, :activity_value_unit, :channel, :activity_performed_env,
          :activity_name, :campaign_code, :tracker_code, :tracker_component_code, :reward_code,
          :reward_category, :reward_value, :reward_value_unit, :reward_entry_date,
          :completion_cycle, :reward_processed_env, :ingestion_channel, :status,
          :external_system_code, :external_reference_id, :redeemed_at,
          now() - interval '1 hour')
       RETURNING id`,
      { type: QueryTypes.SELECT, replacements: f },
    );
    return row.id;
  }

  function fakeServiceConfig(graceSeconds: number): ServiceConfigResolverService {
    return {
      resolve: jest.fn(async (key: string) => {
        if (key === 'completionSweep.graceSeconds') {
          return graceSeconds;
        }
        if (key === 'completionSweep.intervalSeconds') {
          return 3600;
        }
        throw new Error(`unexpected service_config key: ${key}`);
      }),
      // only `resolve` is called by `CompletionSweepService`; typing the rest would add no safety.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
  });

  beforeEach(() => {
    sideEffects = {
      calls: [],
      async recordCompletionSideEffects(entry) {
        this.calls.push(entry);
      },
    };
    stateMachine = new RedemptionStateMachineService(realDbConfigService(), sideEffects);
    metrics = new MetricsRegistry();
  });

  afterEach(async () => {
    await service?.onModuleDestroy();
    await stateMachine.onModuleDestroy();
  });

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.close();
  });

  it('TC-8: a stale dispatched_external row (external_reference_id already populated) resumes at the outbox/notification step only — never re-invokes the connector', async () => {
    const id = await insertStaleDispatchedExternalRow();
    service = new CompletionSweepService(
      stateMachine,
      fakeServiceConfig(60), // 60s grace — this row is ~1 hour stale, well past it
      metrics,
      realDbConfigService(),
    );
    // T-RR-057 regression: captured before the sweep runs — this global/un-tenant-scoped query can,
    // in principle, also pick up a foreign stale row (this test's own note below), so the assertion
    // after the sweep is "increased by at least our own one", not an exact absolute value.
    const completedBefore = metrics.getCounterValue('reward_redemptions_completed_total', {
      system_code: 'PROMO_CODE_SERVICE',
    });

    await service.sweepOnce();

    const [row] = await migrationDb.query<RewardRedemptionEntryRow>(
      'SELECT * FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    expect(row.status).toBe('completed');
    // This sweep query is deliberately global/un-tenant-scoped (§2's own design — "a full-table
    // filter on that rare condition is cheap"), so it can, in principle, also pick up a genuinely
    // stale `dispatched_external` row left behind by a concurrently-running sibling spec file —
    // tolerated the same way `test/processing/reward-redemption-entry-claim.repository.spec.ts`
    // (T-RR-020) already tolerates foreign rows in its own shared-table scan. The property this
    // test actually needs — resumed exactly once, at the outbox/notification step only, never
    // re-invoking any connector — only requires asserting *this test's own* `id`, not the total
    // call count.
    const ownCalls = sideEffects.calls.filter((call) => call.id === id);
    expect(ownCalls).toHaveLength(1);
    expect(row.external_system_code).toBe('PROMO_CODE_SERVICE');
    expect(row.external_reference_id).toBe(ownCalls[0].external_reference_id);

    // T-RR-057 regression: before the fix, this counter never moved for any call site — the real
    // `completeDispatched` resume this sweep just performed must have incremented it by at least
    // our own row's own increment.
    const completedAfter = metrics.getCounterValue('reward_redemptions_completed_total', {
      system_code: 'PROMO_CODE_SERVICE',
    });
    expect(completedAfter).toBeGreaterThanOrEqual(completedBefore + 1);
  });

  it('TC-9: no stale dispatched_external rows present -> no-op, no error', async () => {
    // A fresh (non-stale) dispatched_external row exists, but is not old enough to be swept.
    const freshId = await (async () => {
      const f = baseEntryFields({ external_reference_id: `ext-ref-fresh-${randomUUID()}` });
      const [row] = await migrationDb.query<{ id: string }>(
        `INSERT INTO reward_redemption.reward_redemption_entry
           (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
            activity_performed_date, activity_type, activity_category, activity_value,
            activity_value_unit, channel, activity_performed_env, activity_name, campaign_code,
            tracker_code, tracker_component_code, reward_code, reward_category, reward_value,
            reward_value_unit, reward_entry_date, completion_cycle, reward_processed_env,
            ingestion_channel, status, external_system_code, external_reference_id, redeemed_at)
         VALUES
           (:id, :correlation_id, :tenant_id, :customer_id_encrypted, :customer_id_hash,
            :customer_id_type, :activity_performed_date, :activity_type, :activity_category,
            :activity_value, :activity_value_unit, :channel, :activity_performed_env,
            :activity_name, :campaign_code, :tracker_code, :tracker_component_code, :reward_code,
            :reward_category, :reward_value, :reward_value_unit, :reward_entry_date,
            :completion_cycle, :reward_processed_env, :ingestion_channel, :status,
            :external_system_code, :external_reference_id, :redeemed_at)
         RETURNING id`,
        { type: QueryTypes.SELECT, replacements: f },
      );
      return row.id;
    })();

    service = new CompletionSweepService(
      stateMachine,
      fakeServiceConfig(3600), // 1 hour grace — the fresh row above is nowhere near stale
      metrics,
      realDbConfigService(),
    );

    await expect(service.sweepOnce()).resolves.toBeUndefined();

    expect(sideEffects.calls).toHaveLength(0);
    const [row] = await migrationDb.query<RewardRedemptionEntryRow>(
      'SELECT * FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: freshId } },
    );
    expect(row.status).toBe('dispatched_external');
  });
});
