/**
 * T-RR-041 — TC-6. The direct no-connector `processing -> completed` path
 * (`05-PROCESSING-PIPELINE.md` §2's own row: "§4 resolves **no** connector for this entry at all").
 * Ingests one real entry through `RewardIngestionService` (the identical shared domain method
 * every one of the three real transports calls — R10 — already proven transport-agnostic by
 * `test/modules/reward-ingestion/cross-channel-parity.e2e-spec.ts`, T-RR-014; this file's own
 * concern is what happens *after* ingestion, not re-proving transport parity), claims it, and
 * drives it through the real `RedemptionProcessingOrchestrator` with `ExternalRewardSystemConfigResolver`
 * faked to resolve `null` — "genuinely nothing to call" (`05-PROCESSING-PIPELINE.md` §4 point 2).
 *
 * Real Postgres, real `RedemptionProcessingOrchestrator`/`RedemptionStateMachineService`/
 * `ConnectorRegistry` (never even reached on this path) — only the portal-feed resolution is
 * faked, exactly `test/e2e/observability.e2e-spec.ts`'s own reviewed precedent (this directory's
 * own `fixtures/reward-entry.fixtures.ts` header explains why).
 */
import type { Sequelize } from 'sequelize';
import type { Pool, Client } from 'pg';
import {
  EncryptionService,
  loadEncryptionKeyMaterial,
} from '@/modules/encryption/encryption.service';
import { LogRedactorService } from '@/modules/encryption/log-redactor.service';
import { RewardIngestionService } from '@/modules/reward-ingestion/reward-ingestion.service';
import { RewardRedemptionEntryRepository } from '@/modules/reward-ingestion/reward-redemption-entry.repository';
import type { RewardEntryIngestDto } from '@/modules/reward-ingestion/reward-entry-ingest.dto';
import {
  buildCanonicalFixtureEntry,
  buildClaimRepository,
  buildCoreBankingConnectorConfig,
  buildDbPool,
  buildRealPipeline,
  cleanupEntry,
  claimSpecificEntry,
  countRelatedRows,
  createMigrationDb,
  fetchRow,
  acquireCrossFileClaimMutex,
  realDbConfigService,
  releaseCrossFileClaimMutex,
  stampTenantCountryEnrichment,
} from './fixtures/reward-entry.fixtures';

jest.setTimeout(120_000);

function toIngestDto(tenantId: number): RewardEntryIngestDto {
  const fixture = buildCanonicalFixtureEntry(tenantId);
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
  // A range distinct from every other real-DB spec file's own convention (T-RR-041's own reserved
  // block — see `fixtures/reward-entry.fixtures.ts`'s sibling files for the neighbouring ranges).
  return 964_000_000 + tenantCounter * 10_000 + Math.floor(Math.random() * 9_000);
}

describe('T-RR-041 — direct-completion-no-connector (TC-6)', () => {
  let migrationDb: Sequelize;
  let sharedPool: Pool;
  let mutexClient: Client;
  let ingestionRepo: RewardRedemptionEntryRepository;
  const entryIdsToClean: string[] = [];

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

  it('TC-6: no active connector resolves -> entry reaches completed directly, external_system_code/external_reference_id stay NULL, no external_system_call_log row, no outbox row', async () => {
    const tenantId = nextTenantId();
    const dto = toIngestDto(tenantId);
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

    const { orchestrator } = buildRealPipeline({
      systemCode: 'NO_CONNECTOR_SYSTEM',
      connectorConfig: null,
      notificationsEnabled: false,
      sharedPool,
    });

    const result = await orchestrator.processClaimedEntry(claimed);

    expect(result.status).toBe('completed');
    expect(result.external_system_code).toBeNull();
    expect(result.external_reference_id).toBeNull();
    expect(result.redeemed_at).not.toBeNull();

    const row = await fetchRow(migrationDb, entryId);
    expect(row.status).toBe('completed');
    expect(row.external_system_code).toBeNull();
    expect(row.external_reference_id).toBeNull();

    expect(await countRelatedRows(migrationDb, 'external_system_call_log', entryId)).toBe(0);
    // `RedemptionCompletionSideEffects` is only ever invoked from the `dispatched_external ->
    // completed` transition (`completeDispatched`) — the direct `processing -> completed` path
    // (`markCompletedDirect`) never calls it at all, so no outbox/notification row is written
    // either, matching the design doc's own framing of this as "nothing more from this service
    // than the fact of redemption being recorded".
    expect(await countRelatedRows(migrationDb, 'reward_tracking_dispatch_outbox', entryId)).toBe(0);
    expect(await countRelatedRows(migrationDb, 'notification_log', entryId)).toBe(0);
  });

  it('adjacent behaviour: a distinct entry with a resolved connector config still reaches dispatched_external, not completed directly (control case)', async () => {
    const tenantId = nextTenantId();
    const dto = toIngestDto(tenantId);
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

    const { orchestrator } = buildRealPipeline({
      systemCode: 'CORE_BANKING',
      connectorConfig: buildCoreBankingConnectorConfig(),
      notificationsEnabled: false,
      sharedPool,
    });

    const result = await orchestrator.processClaimedEntry(claimed);
    expect(result.status).toBe('dispatched_external');
    expect(result.external_system_code).toBe('CORE_BANKING');
    expect(result.external_reference_id).not.toBeNull();
  });
});
