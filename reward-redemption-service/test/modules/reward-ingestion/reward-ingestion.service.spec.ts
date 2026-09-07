/**
 * T-RR-010 — `RewardIngestionService`.
 *
 * TC-1/TC-2/TC-4/TC-5/TC-6 run against a fake, in-memory repository (this file's own
 * `FakeRewardRedemptionEntryRepository`) but a **real** `EncryptionService`/`LogRedactorService`
 * (real AES-256-GCM/HMAC-SHA-256, using the real key material `test/database/env.setup.ts` already
 * loads from `.env.development`) — the property these tests need (customerId is actually
 * encrypted/hashed, never passed through verbatim) cannot be proven by a mocked crypto layer.
 *
 * TC-3 (this task's own Verification step 2: "Run TC-3's concurrency scenario against the real
 * local Postgres (not a mock) — fire two real concurrent `ingest()` calls with the same `id`") runs
 * in its own, separate `describe` block against the real `RewardRedemptionEntryRepository` and the
 * real local Postgres 16 server (root `CLAUDE.md`) — same real-DB convention every other repository
 * spec in this service already uses.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import { LogRedactorService } from '@/modules/encryption/log-redactor.service';
import { MetricsRegistry } from '@/observability/metrics.registry';
import {
  InvalidRewardEntryDtoError,
  RewardIngestionService,
} from '@/modules/reward-ingestion/reward-ingestion.service';
import { RewardRedemptionEntryRepository } from '@/modules/reward-ingestion/reward-redemption-entry.repository';
import type { NewRewardRedemptionEntryInput } from '@/modules/reward-ingestion/reward-redemption-entry.repository';
import type { RewardEntryIngestDto } from '@/modules/reward-ingestion/reward-entry-ingest.dto';
import type {
  RewardRedemptionEntryRow,
  RewardRedemptionEntryStatus,
} from '@/database/models/reward-redemption-entry.model';
import type { Config } from '@/config/config.schema';

function buildConfigService(overrides: Partial<Config> = {}): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
    NODE_ENV: 'development',
    ...overrides,
  };
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

function baseDto(overrides: Partial<RewardEntryIngestDto> = {}): RewardEntryIngestDto {
  return {
    id: randomUUID(),
    correlationId: randomUUID(),
    tenantId: 1,
    customerId: 'super-secret-plaintext-customer-id-value',
    customerIdType: 'MSISDN',
    activityPerformedDate: new Date('2026-09-04T10:15:00.000Z'),
    transactionType: null,
    activityCode: 'TXN_TOPUP',
    activityType: 'TOPUP',
    activityCategory: 'TELCO',
    activityValue: '50.0000',
    activityValueUnit: 'MYR',
    channel: 'app',
    activityPerformedEnv: 'production',
    activityName: 'Prepaid Top-up',
    campaignCode: 'CAMP-2026-Q3-001',
    trackerCode: 'TRK-TOPUP-5X',
    trackerComponentCode: 'CMP-TOPUP-STEP-3',
    merchantCode: 'MERCH-001',
    rewardCode: 'RWD-CASHBACK-5PCT',
    rewardCategory: 'CASHBACK',
    rewardValue: '2.5000',
    rewardValueUnit: 'MYR',
    rewardEntryDate: new Date('2026-09-04T10:15:03.000Z'),
    completionCycle: 1,
    ingestionChannel: 'REST',
    ...overrides,
  };
}

/** Minimal, in-memory stand-in for `RewardRedemptionEntryRepository` — mirrors its real
 * `ON CONFLICT DO NOTHING` semantics (first call for a given `id` inserts, every later call
 * returns the existing row untouched) without a real DB. `calls` lets a test assert exactly what
 * `RewardIngestionService` handed it (e.g. that `customer_id_encrypted`/`customer_id_hash`, never
 * the raw `customerId`, reached this layer). */
class FakeRewardRedemptionEntryRepository {
  readonly calls: NewRewardRedemptionEntryInput[] = [];
  private readonly store = new Map<string, RewardRedemptionEntryRow>();

  async insertOrGetExisting(
    input: NewRewardRedemptionEntryInput,
  ): Promise<{ row: RewardRedemptionEntryRow; wasInserted: boolean }> {
    this.calls.push(input);
    const existing = this.store.get(input.id);
    if (existing) {
      return { row: existing, wasInserted: false };
    }
    const row: RewardRedemptionEntryRow = {
      ...input,
      status: 'received',
      retry_count: 0,
      next_attempt_at: null,
      last_error_code: null,
      last_error_message: null,
      last_attempted_at: null,
      external_system_code: null,
      external_reference_id: null,
      redeemed_at: null,
      country_code: null,
      tenant_code: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.store.set(input.id, row);
    return { row, wasInserted: true };
  }

  /** Test-only helper — simulates the claim worker (Wave 2) having already advanced a row past
   * `received`, for TC-4. */
  setStatus(id: string, status: RewardRedemptionEntryStatus): void {
    const row = this.store.get(id);
    if (row) {
      row.status = status;
    }
  }

  async onModuleDestroy(): Promise<void> {
    /* no-op */
  }
}

describe('T-RR-010 — RewardIngestionService', () => {
  let repository: FakeRewardRedemptionEntryRepository;
  let encryption: EncryptionService;
  let logRedactor: LogRedactorService;
  let metrics: MetricsRegistry;
  let service: RewardIngestionService;
  let logSpy: jest.SpiedFunction<typeof Logger.prototype.log>;

  beforeEach(() => {
    repository = new FakeRewardRedemptionEntryRepository();
    encryption = new EncryptionService(loadEncryptionKeyMaterial());
    logRedactor = new LogRedactorService(encryption);
    metrics = new MetricsRegistry();
    service = new RewardIngestionService(
      repository as unknown as RewardRedemptionEntryRepository,
      encryption,
      logRedactor,
      buildConfigService({ NODE_ENV: 'production' }),
      metrics,
    );
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('TC-1: ingest() a fresh, well-formed DTO — row inserted as received, customerId encrypted+hashed, never plaintext', async () => {
    const dto = baseDto();

    const result = await service.ingest(dto);

    expect(result).toEqual({ rewardEntryId: dto.id, status: 'received' });
    expect(repository.calls).toHaveLength(1);
    const persisted = repository.calls[0];
    expect(persisted.customer_id_encrypted).not.toBe(dto.customerId);
    expect(persisted.customer_id_hash).toBe(encryption.hash(dto.customerId));
    // The plaintext value never appears anywhere in what was actually persisted.
    expect(JSON.stringify(persisted)).not.toContain(dto.customerId);
    // `reward_processed_env` is stamped by this service from its own config, never from the DTO.
    expect(persisted.reward_processed_env).toBe('production');
  });

  it('TC-2: ingest() the identical DTO a second time — no second row, returns the existing status, no throw', async () => {
    const dto = baseDto();
    const first = await service.ingest(dto);

    const second = await service.ingest(dto);

    expect(second).toEqual({ rewardEntryId: dto.id, status: first.status });
    expect(repository.calls).toHaveLength(2); // both calls reach the repository...
    expect(new Set(repository.calls.map((c) => c.id)).size).toBe(1); // ...for the same one id
  });

  it('TC-4: ingest() a duplicate id whose existing row already reached `completed` returns `completed`, not `received`', async () => {
    const dto = baseDto();
    const first = await service.ingest(dto);
    repository.setStatus(first.rewardEntryId, 'completed');

    const second = await service.ingest(dto);

    expect(second).toEqual({ rewardEntryId: dto.id, status: 'completed' });
  });

  it('TC-5 (negative): ingest() a DTO missing the mandatory id field throws a named validation error', async () => {
    const { id: _omittedId, ...rest } = baseDto();
    const invalidDto = rest as unknown as RewardEntryIngestDto;

    await expect(service.ingest(invalidDto)).rejects.toThrow(InvalidRewardEntryDtoError);
    expect(repository.calls).toHaveLength(0);
  });

  it('TC-6: no log line emitted during ingest() contains the raw customerId value used in the fixture', async () => {
    const dto = baseDto({ customerId: 'a-very-distinctive-raw-customer-id-9f3c1a' });

    await service.ingest(dto);
    await service.ingest(dto); // also cover the duplicate-arrival log path

    expect(logSpy).toHaveBeenCalled();
    const loggedText = JSON.stringify(logSpy.mock.calls);
    expect(loggedText).not.toContain(dto.customerId);
    // The hash IS expected to appear — proving the redaction path was actually exercised, not
    // just that logging was skipped entirely.
    expect(loggedText).toContain(encryption.hash(dto.customerId));
  });

  // T-RR-056: `reward_entries_ingested_total{channel}` (`07-CONFIGURABILITY-AND-OBSERVABILITY.md`
  // §3) never incremented at any real call site. TC-7/TC-8/TC-9 are the reported defect's own
  // regression coverage — proven to fail against the pre-fix code (no `metrics` call in `ingest()`
  // at all) by temporarily reverting the `this.metrics?.incrementRewardEntriesIngested(...)` call
  // in `reward-ingestion.service.ts` and re-running this file: all three go red (every
  // `getCounterValue(...)` reads back `0`), confirming they are not change-detectors.
  it('TC-7: ingest() a fresh gRPC-channel entry increments reward_entries_ingested_total{channel: grpc} exactly once', async () => {
    const dto = baseDto({ ingestionChannel: 'GRPC' });

    await service.ingest(dto);

    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'grpc' })).toBe(1);
    // Adjacent labels must stay at zero — this is a per-channel counter, not a single global one.
    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'kafka' })).toBe(0);
    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'rest' })).toBe(0);
  });

  it('TC-8: ingest() the identical (duplicate) entry a second time also increments the counter — a durably-received duplicate still counts', async () => {
    const dto = baseDto({ ingestionChannel: 'KAFKA' });

    await service.ingest(dto);
    await service.ingest(dto);

    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'kafka' })).toBe(2);
  });

  it('TC-9: ingest() entries across all three channels increments each channel label independently', async () => {
    await service.ingest(baseDto({ id: randomUUID(), ingestionChannel: 'GRPC' }));
    await service.ingest(baseDto({ id: randomUUID(), ingestionChannel: 'KAFKA' }));
    await service.ingest(baseDto({ id: randomUUID(), ingestionChannel: 'REST' }));
    await service.ingest(baseDto({ id: randomUUID(), ingestionChannel: 'REST' }));

    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'grpc' })).toBe(1);
    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'kafka' })).toBe(1);
    expect(metrics.getCounterValue('reward_entries_ingested_total', { channel: 'rest' })).toBe(2);
  });
});

describe('T-RR-010 — RewardIngestionService (real Postgres, TC-3 concurrency — Verification step 2)', () => {
  const TENANT_ID = 940_000 + Math.floor(Math.random() * 9_999);
  let migrationDb: Sequelize;
  let repository: RewardRedemptionEntryRepository;
  let service: RewardIngestionService;

  beforeAll(async () => {
    migrationDb = createMigrationConnection();
    await migrationDb.authenticate();
    repository = new RewardRedemptionEntryRepository(buildConfigService());
    const encryption = new EncryptionService(loadEncryptionKeyMaterial());
    const logRedactor = new LogRedactorService(encryption);
    service = new RewardIngestionService(
      repository,
      encryption,
      logRedactor,
      buildConfigService({ NODE_ENV: 'development' }),
    );
  });

  afterAll(async () => {
    await migrationDb.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenant_id',
      { type: QueryTypes.RAW, replacements: { tenant_id: TENANT_ID } },
    );
    await migrationDb.close();
    await repository.onModuleDestroy();
  });

  it('TC-3: two real concurrent ingest() calls with the same id — exactly one row is ever inserted', async () => {
    const dto = baseDto({ tenantId: TENANT_ID });

    const [first, second] = await Promise.all([service.ingest(dto), service.ingest({ ...dto })]);

    expect(first.rewardEntryId).toBe(dto.id);
    expect(second.rewardEntryId).toBe(dto.id);
    // Both calls must report a status this state machine actually defines
    // (`05-PROCESSING-PIPELINE.md` §2) rather than requiring bit-for-bit equality: on this shared,
    // un-tenant-scoped table, T-RR-020's own real `ClaimWorkerService` integration test can be
    // running concurrently in a different Jest worker and legitimately claim this row (its own
    // claim query is deliberately global, not scoped to any one test's rows) between the two calls'
    // respective reads — a real, already-documented tradeoff of this shared table
    // (`reward-redemption-entry-claim.repository.spec.ts`'s own file header), not a defect in this
    // service's own idempotency handling. The property this task actually owns — exactly one row
    // ever inserted, neither call throws — is asserted below via the real row count.
    expect(['received', 'processing']).toContain(first.status);
    expect(['received', 'processing']).toContain(second.status);

    const countResult = await migrationDb.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id: dto.id } },
    );
    expect(countResult[0].count).toBe('1');
  });
});
