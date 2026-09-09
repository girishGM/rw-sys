/**
 * T-RR-041 — TC-7. A permanent-failure classification reaches `failed` on the very first attempt,
 * no retry consumed (`05-PROCESSING-PIPELINE.md` §7). Uses the real `PromoCodeServiceConnector`
 * against a mocked global `fetch` (the one true network boundary, per this task's own
 * implementation note 1) returning `CONFIG_NOT_BOUND` — a business rejection *not* present in the
 * resolved `retryable_error_codes` list, per this task's own implementation note 5 and
 * `05-PROCESSING-PIPELINE.md` §5's own worked example.
 */
import { QueryTypes, type Sequelize } from 'sequelize';
import type { Pool, Client } from 'pg';
import { Logger } from '@nestjs/common';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import { LogRedactorService } from '@/modules/encryption/log-redactor.service';
import { RewardIngestionService } from '@/modules/reward-ingestion/reward-ingestion.service';
import { RewardRedemptionEntryRepository } from '@/modules/reward-ingestion/reward-redemption-entry.repository';
import type { RewardEntryIngestDto } from '@/modules/reward-ingestion/reward-entry-ingest.dto';
import {
  PROMO_CODE_AUTH_SECRET_ENV_VAR,
  PROMO_CODE_AUTH_SECRET_VALUE,
  buildCanonicalFixtureEntry,
  buildClaimRepository,
  buildDbPool,
  buildPromoCodeConnectorConfig,
  buildRealPipeline,
  cleanupEntry,
  claimSpecificEntry,
  countRelatedRows,
  createMigrationDb,
  fetchRow,
  jsonResponse,
  promoCodeFailedBody,
  acquireCrossFileClaimMutex,
  realDbConfigService,
  releaseCrossFileClaimMutex,
  stampTenantCountryEnrichment,
} from './fixtures/reward-entry.fixtures';

jest.setTimeout(120_000);

function toIngestDto(tenantId: number, campaignCode: string): RewardEntryIngestDto {
  const fixture = buildCanonicalFixtureEntry(tenantId, { campaignCode });
  return {
    id: fixture.id,
    correlationId: fixture.correlationId,
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
    customerIdType: fixture.customerIdType,
    activityPerformedDate: new Date(fixture.activityPerformedDate),
    transactionType: fixture.transactionType,
    activityCode: fixture.activityCode,
    activityType: fixture.activityType,
    activityCategory: fixture.activityCategory,
    activityValue: fixture.activityValue,
    activityValueUnit: fixture.activityValueUnit,
    channel: fixture.channel,
    activityPerformedEnv: fixture.activityPerformedEnv,
    activityName: fixture.activityName,
    campaignCode: fixture.campaignCode,
    trackerCode: fixture.trackerCode,
    trackerComponentCode: fixture.trackerComponentCode,
    merchantCode: fixture.merchantCode,
    rewardCode: fixture.rewardCode,
    rewardCategory: fixture.rewardCategory,
    rewardValue: fixture.rewardValue,
    rewardValueUnit: fixture.rewardValueUnit,
    rewardEntryDate: new Date(fixture.rewardEntryDate),
    completionCycle: fixture.completionCycle,
    ingestionChannel: 'REST',
  };
}

let tenantCounter = 0;
function nextTenantId(): number {
  tenantCounter += 1;
  return 965_000_000 + tenantCounter * 10_000 + Math.floor(Math.random() * 9_000);
}

describe('T-RR-041 — permanent-failure (TC-7)', () => {
  let migrationDb: Sequelize;
  let sharedPool: Pool;
  let mutexClient: Client;
  let ingestionRepo: RewardRedemptionEntryRepository;
  let fetchSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  const entryIdsToClean: string[] = [];
  const ORIGINAL_ENV = { ...process.env };

  beforeAll(async () => {
    mutexClient = await acquireCrossFileClaimMutex();
    migrationDb = createMigrationDb();
    await migrationDb.authenticate();
    sharedPool = buildDbPool();
    ingestionRepo = new RewardRedemptionEntryRepository(realDbConfigService(), sharedPool);
  }, 300_000);

  afterAll(async () => {
    for (const id of entryIdsToClean) {
      await cleanupEntry(migrationDb, id);
    }
    await sharedPool.end();
    await migrationDb.close();
    await releaseCrossFileClaimMutex(mutexClient);
  }, 60_000);

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      [PROMO_CODE_AUTH_SECRET_ENV_VAR]: PROMO_CODE_AUTH_SECRET_VALUE,
    };
    fetchSpy = jest.spyOn(global, 'fetch');
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    process.env = { ...ORIGINAL_ENV };
  });

  it('TC-7: PromoCodeServiceConnector returns CONFIG_NOT_BOUND (not in retryable_error_codes) -> entry reaches failed on the first attempt, matching reward_redemption_failed row, no retry consumed', async () => {
    const tenantId = nextTenantId();
    const campaignCode = `CAMP-TRR041-PERMFAIL-${tenantId}`;
    const dto = toIngestDto(tenantId, campaignCode);
    const encryption = new EncryptionService(loadEncryptionKeyMaterial());
    const ingestionService = new RewardIngestionService(
      ingestionRepo,
      encryption,
      new LogRedactorService(encryption),
      realDbConfigService(),
    );

    const ingestResult = await ingestionService.ingest(dto);
    const entryId = ingestResult.rewardEntryId;
    entryIdsToClean.push(entryId);
    await stampTenantCountryEnrichment(migrationDb, entryId);

    const claimRepository = buildClaimRepository(sharedPool);
    const claimed = await claimSpecificEntry(claimRepository, migrationDb, entryId);
    expect(claimed.retry_count).toBe(0);

    fetchSpy.mockResolvedValue(jsonResponse(200, promoCodeFailedBody('CONFIG_NOT_BOUND')));

    const { orchestrator } = buildRealPipeline({
      systemCode: 'PROMO_CODE_SERVICE',
      connectorConfig: buildPromoCodeConnectorConfig(),
      notificationsEnabled: false,
      sharedPool,
    });

    const result = await orchestrator.processClaimedEntry(claimed);

    expect(result.status).toBe('failed');
    // No retry consumed — permanent on the very first attempt (§7).
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const row = await fetchRow(migrationDb, entryId);
    expect(row.status).toBe('failed');

    const failedRows = await migrationDb.query<{
      total_attempts: number;
      final_error_code: string | null;
      reward_entry_id: string;
    }>('SELECT * FROM reward_redemption.reward_redemption_failed WHERE reward_entry_id = :id', {
      type: QueryTypes.SELECT,
      replacements: { id: entryId },
    });
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].total_attempts).toBe(1);
    expect(failedRows[0].final_error_code).toBe('CONFIG_NOT_BOUND');

    // §7's own emphatic rule: `failed` is only reachable from `processing`/`retrying` — a
    // permanent failure never writes an outbox/notification row (no successful dispatch ever
    // happened for this entry).
    expect(await countRelatedRows(migrationDb, 'reward_tracking_dispatch_outbox', entryId)).toBe(0);
    expect(await countRelatedRows(migrationDb, 'notification_log', entryId)).toBe(0);
    expect(await countRelatedRows(migrationDb, 'external_system_call_log', entryId)).toBe(1);
  });

  it('adjacent behaviour: the identical CONFIG_NOT_BOUND rejection on a config that DOES list it as retryable instead schedules a retry, never failed', async () => {
    const tenantId = nextTenantId();
    const campaignCode = `CAMP-TRR041-PERMFAIL-CTRL-${tenantId}`;
    const dto = toIngestDto(tenantId, campaignCode);
    const encryption = new EncryptionService(loadEncryptionKeyMaterial());
    const ingestionService = new RewardIngestionService(
      ingestionRepo,
      encryption,
      new LogRedactorService(encryption),
      realDbConfigService(),
    );
    const ingestResult = await ingestionService.ingest(dto);
    const entryId = ingestResult.rewardEntryId;
    entryIdsToClean.push(entryId);
    await stampTenantCountryEnrichment(migrationDb, entryId);

    const claimRepository = buildClaimRepository(sharedPool);
    const claimed = await claimSpecificEntry(claimRepository, migrationDb, entryId);

    fetchSpy.mockResolvedValue(jsonResponse(200, promoCodeFailedBody('CONFIG_NOT_BOUND')));

    const { orchestrator } = buildRealPipeline({
      systemCode: 'PROMO_CODE_SERVICE',
      connectorConfig: buildPromoCodeConnectorConfig({
        retryable_error_codes: ['CONFIG_NOT_BOUND'],
      }),
      notificationsEnabled: false,
      sharedPool,
    });

    const result = await orchestrator.processClaimedEntry(claimed);
    expect(result.status).toBe('retrying');
    expect(result.retry_count).toBe(1);
  });
});
