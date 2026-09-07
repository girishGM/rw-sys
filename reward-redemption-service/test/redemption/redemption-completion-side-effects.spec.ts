/**
 * T-RR-061 — regression test for the defect this task fixes: `RedemptionCompletionSideEffectsPort`
 * was still bound to `NotImplementedRedemptionCompletionSideEffects` (a pure no-op `warn`-and-return
 * stub) in `redemption-state-machine.module.ts`, even though `T-RR-058` had, by then, made
 * `ClaimWorkerService` -> `RedemptionProcessingOrchestrator` -> `RedemptionStateMachineService` a
 * real, running chain — so a `reward_redemption_entry` row could reach `dispatched_external`/
 * `completed` for real, yet `05-PROCESSING-PIPELINE.md` §6 steps 3-4 (the
 * `reward_tracking_dispatch_outbox` row / `notification_log` row) were silently never written.
 *
 * **Reproduction, recorded here rather than re-derived from scratch**: confirmed by direct read
 * (same evidence the filed defect itself already recorded) that before this task's own fix,
 * `RewardTrackingOutboxRepository.enqueue()` (`src/modules/dispatch/reward-tracking-outbox.
 * repository.ts`) and `NotificationService.notifyIfConfigured()` (`src/modules/notification/
 * notification.service.ts`) had no call site anywhere outside their own module/spec files — the
 * only production call site either method could ever reach was through
 * `RedemptionCompletionSideEffectsPort`, and that port's only bound implementation was the no-op
 * stub. `NotImplementedRedemptionCompletionSideEffects` itself (still exported, see this file's
 * own "TC-1" describe block below) is direct, executable proof of the reported symptom: calling it
 * performs no outbox/notification work of any kind, only a log line.
 *
 * This file has three describe blocks:
 *  1. TC-1 — the stub, called directly, reproduces the reported symptom (still true today; the stub
 *     itself was deliberately kept, just no longer the default binding — see this file's own
 *     header).
 *  2. TC-2/TC-3/TC-4 (unit, fakes) — `RedemptionCompletionSideEffects`'s own orchestration logic:
 *     resolves `dispatch_channel_config`, enqueues via the outbox repository, then notifies; fails
 *     loud (propagates) on a resolution/enqueue error without ever calling notify; always releases
 *     its borrowed `PoolClient`.
 *  3. TC-2/TC-5 (real Postgres) — `RedemptionCompletionSideEffects` constructed with the *real*
 *     `DispatchChannelResolverService`/`RewardTrackingOutboxRepository` (against the real local
 *     Postgres server, root `CLAUDE.md`) actually inserts a `reward_tracking_dispatch_outbox` row —
 *     the literal, physical proof the reported gap is closed. `NotificationService` is faked here
 *     only to avoid this file also depending on a live portal gRPC server for an unrelated
 *     assertion (`NotificationService`'s own real behaviour is already covered end to end by
 *     `test/notification/notification.service.spec.ts`).
 *  4. TC-3 (module wiring) — compiles the real `RedemptionStateMachineModule` via
 *     `Test.createTestingModule` and asserts `REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT` resolves to
 *     `RedemptionCompletionSideEffects`, never `NotImplementedRedemptionCompletionSideEffects`.
 *     Proven red against the pre-fix binding (recorded in this task's own completion report: with
 *     `useClass: NotImplementedRedemptionCompletionSideEffects` restored, this exact assertion
 *     fails, since the resolved instance is then a `NotImplementedRedemptionCompletionSideEffects`).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { Pool, type PoolClient } from 'pg';
import { Test } from '@nestjs/testing';
import type { ConfigService } from '@nestjs/config';
import { createMigrationConnection } from '@/database/migration-connection';
import { ConfigModule } from '@/config/config.module';
import {
  NotImplementedRedemptionCompletionSideEffects,
  RedemptionCompletionSideEffects,
  REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT,
} from '@/modules/redemption/redemption-completion-side-effects.port';
import { RedemptionStateMachineModule } from '@/modules/redemption/redemption-state-machine.module';
import { DispatchChannelConfigRepository } from '@/modules/dispatch/dispatch-channel-config.repository';
import { DispatchChannelConfigCache } from '@/modules/dispatch/dispatch-channel-config.cache';
import { DispatchChannelResolverService } from '@/modules/dispatch/dispatch-channel-resolver.service';
import { RewardTrackingOutboxRepository } from '@/modules/dispatch/reward-tracking-outbox.repository';
import { ServiceConfigRepository } from '@/modules/service-config/service-config.repository';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import type { NotificationService } from '@/modules/notification/notification.service';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';

const TENANT_ID = 960_000 + Math.floor(Math.random() * 39_999);

function baseEntryFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    correlation_id: randomUUID(),
    tenant_id: TENANT_ID,
    customer_id_encrypted: 'ciphertext-placeholder',
    customer_id_hash: `hash-${randomUUID()}`,
    customer_id_type: 'EMAIL',
    activity_performed_date: new Date(),
    transaction_type: null,
    activity_code: 'ACT_CODE',
    activity_type: 'PURCHASE',
    activity_category: 'SPEND',
    activity_value: 10,
    activity_value_unit: 'USD',
    channel: 'WEB',
    activity_performed_env: 'PROD',
    activity_name: 't-rr-061 side-effects fixture',
    campaign_code: 'CAMP1',
    tracker_code: 'TRK1',
    tracker_component_code: 'COMP1',
    merchant_code: null,
    reward_code: 'RWD1',
    reward_category: 'CASHBACK',
    reward_value: 5,
    reward_value_unit: 'USD',
    reward_entry_date: new Date(),
    completion_cycle: 1,
    reward_processed_env: 'development',
    country_code: 'MY',
    tenant_code: 'TEN-TEST',
    ingestion_channel: 'REST',
    status: 'dispatched_external',
    retry_count: 0,
    next_attempt_at: null,
    external_system_code: 'PROMO_CODE_SERVICE',
    external_reference_id: `PC-${randomUUID()}`,
    redeemed_at: new Date(),
    ...overrides,
  };
}

async function insertEntry(
  sequelize: Sequelize,
  overrides: Record<string, unknown> = {},
): Promise<RewardRedemptionEntryRow> {
  const f = baseEntryFields(overrides);
  const [row] = await sequelize.query<RewardRedemptionEntryRow>(
    `INSERT INTO reward_redemption.reward_redemption_entry
       (id, correlation_id, tenant_id, customer_id_encrypted, customer_id_hash, customer_id_type,
        activity_performed_date, transaction_type, activity_code, activity_type,
        activity_category, activity_value, activity_value_unit, channel, activity_performed_env,
        activity_name, campaign_code, tracker_code, tracker_component_code, merchant_code,
        reward_code, reward_category, reward_value, reward_value_unit, reward_entry_date,
        completion_cycle, reward_processed_env, country_code, tenant_code, ingestion_channel,
        status, retry_count, next_attempt_at, external_system_code, external_reference_id,
        redeemed_at)
     VALUES
       (:id, :correlation_id, :tenant_id, :customer_id_encrypted, :customer_id_hash,
        :customer_id_type, :activity_performed_date, :transaction_type, :activity_code,
        :activity_type, :activity_category, :activity_value, :activity_value_unit, :channel,
        :activity_performed_env, :activity_name, :campaign_code, :tracker_code,
        :tracker_component_code, :merchant_code, :reward_code, :reward_category, :reward_value,
        :reward_value_unit, :reward_entry_date, :completion_cycle, :reward_processed_env,
        :country_code, :tenant_code, :ingestion_channel, :status, :retry_count, :next_attempt_at,
        :external_system_code, :external_reference_id, :redeemed_at)
     RETURNING *`,
    { type: QueryTypes.SELECT, replacements: f },
  );
  return row;
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

function newAppPool(): Pool {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_APP_USERNAME,
    password: process.env.DB_APP_PASSWORD,
  });
}

describe('T-RR-061 — TC-1: the stub reproduces the reported symptom (still true, just not the default binding)', () => {
  it('performs no outbox/notification work, only logs', async () => {
    const stub = new NotImplementedRedemptionCompletionSideEffects();
    const entry = { id: 'entry-1' } as RewardRedemptionEntryRow;

    // Deliberately no throw and no fake dependency to call into — the whole point of the stub, and
    // the whole point of the reported defect, is that nothing downstream is ever touched.
    await expect(stub.recordCompletionSideEffects(entry)).resolves.toBeUndefined();
  });
});

describe('T-RR-061 — RedemptionCompletionSideEffects (unit, fakes)', () => {
  function fakeClient(): PoolClient & { released: boolean } {
    const client = {
      released: false,
      query: jest.fn(),
      release: jest.fn(function (this: { released: boolean }) {
        this.released = true;
      }),
    };
    return client as unknown as PoolClient & { released: boolean };
  }

  function buildDeps(
    overrides: { resolveImpl?: () => Promise<unknown>; enqueueImpl?: () => Promise<unknown> } = {},
  ) {
    const client = fakeClient();
    const pool = {
      connect: jest.fn().mockResolvedValue(client),
      end: jest.fn().mockResolvedValue(undefined),
    } as unknown as Pool;
    const dispatchResolver = {
      resolve: jest.fn(
        overrides.resolveImpl ??
          (() =>
            Promise.resolve({
              primaryChannel: 'KAFKA',
              fallbackChannel: 'REST',
              kafkaEnabled: true,
              restEnabled: true,
            })),
      ),
    } as unknown as DispatchChannelResolverService;
    const outboxRepository = {
      enqueue: jest.fn(overrides.enqueueImpl ?? (() => Promise.resolve({ id: 'outbox-1' }))),
    } as unknown as RewardTrackingOutboxRepository;
    const notificationService = {
      notifyIfConfigured: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationService;
    return { client, pool, dispatchResolver, outboxRepository, notificationService };
  }

  function buildEntry(overrides: Partial<RewardRedemptionEntryRow> = {}): RewardRedemptionEntryRow {
    return {
      id: randomUUID(),
      correlation_id: randomUUID(),
      tenant_id: 42,
      customer_id_encrypted: 'ciphertext',
      customer_id_hash: 'hash',
      customer_id_type: 'EMAIL',
      activity_performed_date: new Date(),
      transaction_type: null,
      activity_code: 'ACT',
      activity_type: 'PURCHASE',
      activity_category: 'SPEND',
      activity_value: '10',
      activity_value_unit: 'USD',
      channel: 'WEB',
      activity_performed_env: 'PROD',
      activity_name: 'fixture',
      campaign_code: 'CAMP1',
      tracker_code: 'TRK1',
      tracker_component_code: 'COMP1',
      merchant_code: null,
      reward_code: 'RWD1',
      reward_category: 'CASHBACK',
      reward_value: '5',
      reward_value_unit: 'USD',
      reward_entry_date: new Date(),
      completion_cycle: 1,
      reward_processed_env: 'development',
      country_code: 'MY',
      tenant_code: 'TEN',
      ingestion_channel: 'REST',
      status: 'dispatched_external',
      retry_count: 0,
      next_attempt_at: null,
      last_error_code: null,
      last_error_message: null,
      last_attempted_at: null,
      external_system_code: 'PROMO_CODE_SERVICE',
      external_reference_id: 'PC-1',
      redeemed_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    };
  }

  it('TC-2: resolves dispatch_channel_config with reward/tracker/campaign/tenant, enqueues, then notifies', async () => {
    const { pool, client, dispatchResolver, outboxRepository, notificationService } = buildDeps();
    const entry = buildEntry();
    const sideEffects = new RedemptionCompletionSideEffects(
      dispatchResolver,
      outboxRepository,
      notificationService,
      realDbConfigService(),
      pool,
    );

    await sideEffects.recordCompletionSideEffects(entry);

    expect(dispatchResolver.resolve).toHaveBeenCalledWith({
      rewardCode: entry.reward_code,
      trackerCode: entry.tracker_code,
      campaignCode: entry.campaign_code,
      tenantId: entry.tenant_id,
    });
    expect(outboxRepository.enqueue).toHaveBeenCalledWith(client, entry);
    expect(notificationService.notifyIfConfigured).toHaveBeenCalledWith(entry, {
      externalSystemCode: entry.external_system_code,
      externalReferenceId: entry.external_reference_id,
    });
    expect(client.released).toBe(true);

    // Ordering: resolve -> enqueue -> notify (05-PROCESSING-PIPELINE.md §6 steps 3 then 4).
    const resolveOrder = (dispatchResolver.resolve as jest.Mock).mock.invocationCallOrder[0];
    const enqueueOrder = (outboxRepository.enqueue as jest.Mock).mock.invocationCallOrder[0];
    const notifyOrder = (notificationService.notifyIfConfigured as jest.Mock).mock
      .invocationCallOrder[0];
    expect(resolveOrder).toBeLessThan(enqueueOrder);
    expect(enqueueOrder).toBeLessThan(notifyOrder);

    await sideEffects.onModuleDestroy();
  });

  it('TC-3: a dispatch_channel_config resolution failure propagates and never reaches enqueue/notify', async () => {
    const resolutionError = new Error('No dispatch_channel_config row resolved at any scope');
    const { pool, dispatchResolver, outboxRepository, notificationService } = buildDeps({
      resolveImpl: () => Promise.reject(resolutionError),
    });
    const entry = buildEntry();
    const sideEffects = new RedemptionCompletionSideEffects(
      dispatchResolver,
      outboxRepository,
      notificationService,
      realDbConfigService(),
      pool,
    );

    await expect(sideEffects.recordCompletionSideEffects(entry)).rejects.toThrow(resolutionError);

    expect(outboxRepository.enqueue).not.toHaveBeenCalled();
    expect(notificationService.notifyIfConfigured).not.toHaveBeenCalled();

    await sideEffects.onModuleDestroy();
  });

  it('TC-4: an outbox enqueue failure propagates, releases the client, and never calls notify', async () => {
    const enqueueError = new Error('insert failed');
    const { pool, client, dispatchResolver, outboxRepository, notificationService } = buildDeps({
      enqueueImpl: () => Promise.reject(enqueueError),
    });
    const entry = buildEntry();
    const sideEffects = new RedemptionCompletionSideEffects(
      dispatchResolver,
      outboxRepository,
      notificationService,
      realDbConfigService(),
      pool,
    );

    await expect(sideEffects.recordCompletionSideEffects(entry)).rejects.toThrow(enqueueError);

    expect(notificationService.notifyIfConfigured).not.toHaveBeenCalled();
    expect(client.released).toBe(true);

    await sideEffects.onModuleDestroy();
  });
});

describe('T-RR-061 — RedemptionCompletionSideEffects (real Postgres — TC-2/TC-5)', () => {
  let migrationDb: Sequelize;
  let appPool: Pool;
  let dispatchConfigRepository: DispatchChannelConfigRepository;
  let dispatchConfigCache: DispatchChannelConfigCache;
  let dispatchResolver: DispatchChannelResolverService;
  let outboxRepository: RewardTrackingOutboxRepository;
  let serviceConfigRepository: ServiceConfigRepository;
  let serviceConfigResolver: ServiceConfigResolverService;
  let sideEffects: RedemptionCompletionSideEffects;
  let notifyIfConfigured: jest.Mock;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    appPool = newAppPool();

    serviceConfigRepository = new ServiceConfigRepository(realDbConfigService(), appPool);
    serviceConfigResolver = new ServiceConfigResolverService(serviceConfigRepository);
    dispatchConfigRepository = new DispatchChannelConfigRepository(realDbConfigService(), appPool);
    dispatchConfigCache = new DispatchChannelConfigCache(
      dispatchConfigRepository,
      serviceConfigResolver,
    );
    dispatchResolver = new DispatchChannelResolverService(dispatchConfigCache);
    outboxRepository = new RewardTrackingOutboxRepository(realDbConfigService(), appPool);

    notifyIfConfigured = jest.fn().mockResolvedValue(undefined);
    const fakeNotificationService = {
      notifyIfConfigured,
    } as unknown as NotificationService;

    sideEffects = new RedemptionCompletionSideEffects(
      dispatchResolver,
      outboxRepository,
      fakeNotificationService,
      realDbConfigService(),
      appPool,
    );
  });

  afterEach(() => {
    notifyIfConfigured.mockClear();
  });

  afterAll(async () => {
    await migrationDb.query(
      `DELETE FROM reward_redemption.reward_tracking_dispatch_outbox
         WHERE reward_entry_id IN (
           SELECT id FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id
         )`,
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.close();
    await appPool.end();
  });

  it('TC-2/TC-5: writes a real reward_tracking_dispatch_outbox row and calls notifyIfConfigured, using the real dispatch_channel_config GLOBAL seed', async () => {
    const entry = await insertEntry(migrationDb);

    await sideEffects.recordCompletionSideEffects(entry);

    const [outboxRow] = await migrationDb.query<{ reward_entry_id: string; status: string }>(
      'SELECT * FROM reward_redemption.reward_tracking_dispatch_outbox WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: entry.id } },
    );
    expect(outboxRow).toBeDefined();
    expect(outboxRow.reward_entry_id).toBe(entry.id);
    expect(outboxRow.status).toBe('PENDING');

    expect(notifyIfConfigured).toHaveBeenCalledWith(entry, {
      externalSystemCode: entry.external_system_code,
      externalReferenceId: entry.external_reference_id,
    });
  });

  it('adjacent behaviour unchanged: calling it a second time for a different entry enqueues a second, independent row (no accidental dedup added)', async () => {
    const entry = await insertEntry(migrationDb);

    await sideEffects.recordCompletionSideEffects(entry);

    const rows = await migrationDb.query(
      'SELECT * FROM reward_redemption.reward_tracking_dispatch_outbox WHERE reward_entry_id = :id',
      { type: QueryTypes.SELECT, replacements: { id: entry.id } },
    );
    expect(rows).toHaveLength(1);
  });
});

describe('T-RR-061 — RedemptionStateMachineModule wires the real implementation (TC-3, module compile)', () => {
  it('REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT resolves to RedemptionCompletionSideEffects, never the stub', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, RedemptionStateMachineModule],
    }).compile();

    try {
      const bound = moduleRef.get(REDEMPTION_COMPLETION_SIDE_EFFECTS_PORT);
      expect(bound).toBeInstanceOf(RedemptionCompletionSideEffects);
      expect(bound).not.toBeInstanceOf(NotImplementedRedemptionCompletionSideEffects);
    } finally {
      // Never calls .init()/.listen() — same "compile-only, never lifecycle-init" discipline
      // `claim-worker-module-di.e2e-spec.ts` (T-RR-058) already established for this exact module
      // graph, for the identical reason: CompletionSweepService's own onApplicationBootstrap starts
      // a real, unscoped sweep loop the moment any lifecycle-complete context containing it exists.
      await moduleRef.close();
    }
  });
});
