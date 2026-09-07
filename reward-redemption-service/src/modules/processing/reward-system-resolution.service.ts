/**
 * T-RR-022. Resolves a claimed `reward_redemption_entry`'s `campaign_code`/`tracker_code`/
 * `tracker_component_code`/`reward_code` to the `BoundReward` the portal's cached feed holds for
 * it — `05-PROCESSING-PIPELINE.md` §4's own "lookup 1" (the *second* lookup,
 * `external_reward_system_config` by `system_code`, is T-RR-023's job, explicitly Out of scope
 * here).
 *
 * **A load-bearing correction to what `reward_code` actually contains, recorded here per
 * `AGENT-PROTOCOL.md` §3's "a contradiction ... must be recorded in the doc before code follows
 * it".** Both this document's own §4 and `03-GRPC-CONTRACT.md` §3 describe resolution as looking
 * up the cached `BoundReward` "for this `reward_code`" as if `BoundReward` itself carried a
 * `reward_code` field to match against — it does not (confirmed by direct read of
 * `portal/back-end/proto/campaign_config.v1.proto` lines 192-209 and this service's own client-side
 * copy, `proto/campaign_config.proto`): `BoundReward` exposes only `reward_id` (an internal,
 * portal-numeric id — R5 forbids resolving against another service's internal id directly) and
 * `system_code`, never a `reward_code` string. The actual join key is `BoundReward.system_code`,
 * confirmed by direct read of RAP's own `rule-evaluation-row-handler.service.ts`
 * (`realtime-activity-processing-service/src/modules/processing/rule-evaluation-row-handler.service.ts`,
 * the code that originates every `reward_entry`/`RewardEntry.reward_code` value this service ever
 * receives): it populates `reward_code` from `granted.reward.systemCode` — i.e. `BoundReward.
 * system_code` — not from any portal-side "reward code" concept, because none exists on this
 * message. This service's own `reward_redemption_entry.reward_code` column therefore already
 * holds the value this step needs to match against `BoundReward.system_code`; "resolution" is
 * confirming a live, correctly-scoped `BoundReward` still exists for that value (and reading its
 * `unit_type`/`unit_code`/`delivery_mode`/`version_no`/`level`/`ref_id`), not translating one code
 * space into another. See this task's own completion report for the full evidence trail.
 *
 * **Level/`ref_id` scoping** (implementation note 4): a `system_code` can legitimately be bound at
 * more than one level within the same campaign (e.g. the same connector reused for both a
 * campaign-level welcome bonus and a tracker-level milestone bonus) or not at all at the level the
 * triggering activity actually happened at — the entry's own `trackerCode`/`trackerComponentCode`
 * describe *which activity completion produced this entry*, not necessarily the level the matching
 * reward is bound at. This service therefore builds every level/`ref_id` candidate the entry could
 * plausibly resolve to (`campaign` @ `ref_id=0` always; `tracker` @ the feed's own `trackerId` when
 * `trackerCode` matches a tracker in the feed; `component` @ the feed's own `componentId` when
 * `trackerComponentCode` matches a component of that same tracker) and matches `system_code` against
 * whichever of those candidates the cached config actually has a `BoundReward` for — never a direct
 * string comparison against the entry's own `trackerCode`/`trackerComponentCode` (TC-2).
 *
 * **T-RR-065 (defect fix) also lives in this file.** `TenantSchemaEnrichmentService` below is a
 * second, adjacent-in-pipeline-but-unrelated-in-purpose class: `06-CACHING-AND-TENANT-CONFIG.md`
 * §5's claim-time `tenant_code`/`country_code` enrichment step, which must run *before* this file's
 * own `RewardSystemResolutionService.resolve()` (§5's own ordering note: "immediately after a row
 * is claimed ... before §4's reward-system resolution"). It was never implemented anywhere — filed
 * as a defect against `agent-rr-processing` (T-RR-040's own audit, `tasks/T-RR-065-*.md`) because
 * the only legitimate call site for it (`RedemptionProcessingOrchestrator.processClaimedEntry`) is
 * one of this task's three owned files, and this file (already owned by the same agent, T-RR-022)
 * is the only one of the three with room for a second, related-but-distinct class — the same "extra
 * export added when the implementation genuinely needs it, inside this agent's own scope" precedent
 * `reward-tracking-outbox.repository.ts`'s own header already documents for T-RR-035. It is not
 * folded into `RewardSystemResolutionService` itself because that class's own `resolve()` never
 * sees (or needs) the full entry row or a DB write capability — only the four string fields
 * `RewardSystemResolutionInput` already declares — and giving it one merely to serve an unrelated
 * enrichment step would blur what this class's own docblock above already establishes as its one
 * job (§4's "lookup 1").
 */
import { Injectable, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import type { RewardRedemptionEntryRow } from '@/database/models/reward-redemption-entry.model';
import { TenantSchemaConfigCache } from '@/modules/tenant-schema-cache/tenant-schema-config.cache';
import { CampaignConfigCache } from './campaign-config.cache';
import type { BoundRewardProto, CampaignConfigProto } from './campaign-config.client';

export interface RewardSystemResolutionInput {
  tenantId: number;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  rewardCode: string;
}

export interface ResolvedRewardSystem {
  systemCode: string;
  rewardType: string;
  deliveryMode: string;
  unitType: string;
  unitCode: string;
  level: string;
  refId: number;
  versionNo: number;
  status: string;
  /**
   * T-RR-063: `BoundReward.expiry_value`/`expiry_unit` (T-173), mapped from the proto's own
   * `0`/`''` "never expires" sentinel to `null`/`null` — never `0`/`''` themselves, so a caller
   * (`RedemptionProcessingOrchestrator` -> `computeExpiresAt`, `expiry-computation.ts`) can treat
   * `null` as the one, unambiguous "no expiry" signal.
   *
   * **Optional (`?`), not just nullable**, for the identical cross-scope reason
   * `reward-redemption-entry.model.ts`'s own `expires_at` is optional (see that field's own
   * comment): this interface was already constructed as a full object literal by fixture builders
   * outside this task's file scope (`test/e2e/observability.e2e-spec.ts`,
   * `test/e2e/fixtures/reward-entry.fixtures.ts`, R3) before this task added these two fields.
   * `RedemptionProcessingOrchestrator` (this task's own file) treats an omitted value identically
   * to an explicit `null` (`?? null` at its own call site) — a fixture that predates T-RR-063 and
   * never set an opinion on expiry gets the same "never expires" behavior a real
   * `RewardSystemResolutionService.resolve()` call would give it for a `BoundReward` with no
   * expiry configured.
   */
  expiryValue?: number | null;
  expiryUnit?: 'minutes' | 'hours' | 'days' | null;
}

/** TC-5: thrown instead of returning `undefined`/proceeding with a guessed `system_code` when no
 * `BoundReward` in the cached campaign config matches this entry's `rewardCode` at any level/ref_id
 * candidate the entry could plausibly resolve to. */
export class RewardNotFoundInCampaignConfigError extends Error {
  constructor(input: RewardSystemResolutionInput) {
    super(
      `No BoundReward found in campaign config for tenant_id=${input.tenantId} ` +
        `campaign_code="${input.campaignCode}" matching reward_code (system_code)="${input.rewardCode}" ` +
        `at any of the level/ref_id candidates derived from tracker_code="${input.trackerCode}"/` +
        `tracker_component_code="${input.trackerComponentCode}".`,
    );
    this.name = 'RewardNotFoundInCampaignConfigError';
  }
}

interface LevelRefIdCandidate {
  level: string;
  refId: number;
}

/** Every level/`ref_id` pair this entry could plausibly resolve a `BoundReward` at — see this
 * file's own header on why this is a candidate SET, not a single pre-decided level. */
function buildCandidates(
  config: CampaignConfigProto,
  trackerCode: string,
  trackerComponentCode: string,
): LevelRefIdCandidate[] {
  const candidates: LevelRefIdCandidate[] = [{ level: 'campaign', refId: 0 }];

  const tracker = config.trackers.find((t) => t.trackerCode === trackerCode);
  if (!tracker) {
    return candidates;
  }
  candidates.push({ level: 'tracker', refId: tracker.trackerId });

  const component = tracker.components.find((c) => c.componentCode === trackerComponentCode);
  if (component) {
    candidates.push({ level: 'component', refId: component.componentId });
  }
  return candidates;
}

function findBoundReward(
  config: CampaignConfigProto,
  rewardCode: string,
  candidates: readonly LevelRefIdCandidate[],
): BoundRewardProto | undefined {
  return config.rewards.find(
    (reward) =>
      reward.systemCode === rewardCode &&
      candidates.some((c) => c.level === reward.level && c.refId === reward.refId),
  );
}

@Injectable()
export class RewardSystemResolutionService {
  constructor(private readonly campaignConfigCache: CampaignConfigCache) {}

  async resolve(input: RewardSystemResolutionInput): Promise<ResolvedRewardSystem> {
    const config = await this.campaignConfigCache.get(input.tenantId, input.campaignCode);
    const candidates = buildCandidates(config, input.trackerCode, input.trackerComponentCode);
    const match = findBoundReward(config, input.rewardCode, candidates);
    if (!match) {
      throw new RewardNotFoundInCampaignConfigError(input);
    }
    return {
      systemCode: match.systemCode,
      rewardType: match.rewardType,
      deliveryMode: match.deliveryMode,
      unitType: match.unitType,
      unitCode: match.unitCode,
      level: match.level,
      refId: match.refId,
      versionNo: match.versionNo,
      status: match.status,
      // T-RR-063. Deliberately `|| null`, not `??` (proto3's `int32`/`string` defaults are always
      // present — `protoLoader`'s `defaults: true`, `campaign-config.client.ts`'s own construction
      // — so `match.expiryValue`/`match.expiryUnit` are never `undefined`; `??` would let the
      // proto's own documented `0`/`''` "never expires" sentinel pass straight through as `0`/`''`
      // instead of the `null`/`null` every downstream consumer relies on, TC-3/TC-4).
      expiryValue: match.expiryValue || null,
      expiryUnit: (match.expiryUnit || null) as 'minutes' | 'hours' | 'days' | null,
    };
  }
}

/**
 * T-RR-065 TC-5: thrown instead of guessing when `tenant_schema_config` does not resolve to
 * exactly one active row for `(tenant_id, environment)` — `06-CACHING-AND-TENANT-CONFIG.md` §5
 * point 2's own "operator data error" framing, never silently picked around.
 */
export class TenantSchemaResolutionError extends Error {
  constructor(tenantId: number, environment: string, matchCount: number) {
    super(
      `tenant_schema_config resolution for tenant_id=${tenantId} environment="${environment}" ` +
        `matched ${matchCount} active row(s) — expected exactly 1 (06-CACHING-AND-TENANT-CONFIG.md ` +
        '§5 point 2: this is treated as an operator data error, never guessed at).',
    );
    this.name = 'TenantSchemaResolutionError';
  }
}

/**
 * T-RR-065. `06-CACHING-AND-TENANT-CONFIG.md` §5's claim-time enrichment step — resolves this
 * entry's `tenant_schema_config` row (scoped by `(tenant_id, environment, is_active)`, T-RR-007's
 * own `TenantSchemaConfigCache`) and stamps `tenant_code`/`country_code` onto the claimed
 * `reward_redemption_entry` row, *before* §4's reward-system resolution runs
 * (`RedemptionProcessingOrchestrator.processClaimedEntry`'s own first step, T-RR-024). Without
 * this, `RewardTrackingOutboxRepository.buildOutboxPayload` throws on every entry that ever
 * reaches `dispatched_external`/`completed` (the defect this task fixes), and
 * `08-EXTERNAL-INTEGRATION-CONTRACTS.md`'s own `ClaimedRewardEntry` contract ("with whatever ...
 * enrichment is already stamped onto it by the time it reaches this step", confirmed by direct
 * read of `reward-system-connector.interface.ts`) is silently violated for every connector call —
 * `core-banking.connector.ts` already reads `entry.tenant_code`/`entry.country_code` off the row a
 * connector receives.
 *
 * **Idempotent across retries.** Once `tenant_code`/`country_code` are non-`NULL` on the entry
 * (this service's own prior successful run for it), `enrich()` returns the row unchanged rather
 * than re-resolving — a redemption's tenant/country assignment is a fact established once for that
 * entry, not something a later retry attempt should silently re-derive differently if
 * `tenant_schema_config` happens to change in between attempts.
 *
 * **`environment` is a static, instance-level fact** (`NODE_ENV`, §5 point 1) — resolved once in
 * the constructor, never re-read per call.
 *
 * Persists via its own small `pg.Pool` (the `rr_app` least-privilege role) — no shared runtime DB
 * pool module exists anywhere in this service (same convention every other repository in this
 * service already follows, e.g. `reward-redemption-entry-claim.repository.ts`).
 */
@Injectable()
export class TenantSchemaEnrichmentService implements OnModuleDestroy {
  private readonly environment: string;
  private readonly pool: Pool;

  /** Second constructor parameter is a real, DI-resolvable class (`TenantSchemaConfigCache`,
   * exported by `TenantSchemaCacheModule`) — only the trailing `pool` seam needs `@Optional()`,
   * same "test-owned pool substitute" idiom every repository in this service already uses. */
  constructor(
    config: ConfigService<Config, true>,
    private readonly tenantSchemaConfigCache: TenantSchemaConfigCache,
    @Optional() pool?: Pool,
  ) {
    this.environment = config.get('NODE_ENV', { infer: true });
    this.pool =
      pool ??
      new Pool({
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        database: config.get('DB_NAME', { infer: true }),
        user: config.get('DB_APP_USERNAME', { infer: true }),
        password: config.get('DB_APP_PASSWORD', { infer: true }),
        ssl: config.get('DB_SSL', { infer: true }) ? { rejectUnauthorized: false } : undefined,
      });
  }

  async enrich(entry: RewardRedemptionEntryRow): Promise<RewardRedemptionEntryRow> {
    if (entry.tenant_code !== null && entry.country_code !== null) {
      return entry;
    }

    const rows = await this.tenantSchemaConfigCache.get({
      tenantId: entry.tenant_id,
      environment: this.environment,
    });
    if (rows.length !== 1) {
      throw new TenantSchemaResolutionError(entry.tenant_id, this.environment, rows.length);
    }
    const [resolved] = rows;

    const result = await this.pool.query<RewardRedemptionEntryRow>(
      `UPDATE reward_redemption.reward_redemption_entry
          SET tenant_code = $1, country_code = $2, updated_at = now()
        WHERE id = $3
        RETURNING *`,
      [resolved.tenant_code, resolved.country_code, entry.id],
    );
    const updated = result.rows[0];
    if (updated === undefined) {
      throw new Error(
        `Claim-time tenant/country enrichment UPDATE for reward_redemption_entry ${entry.id} ` +
          'returned no row — the row disappeared between claim and enrichment (structurally ' +
          'unreachable, since nothing in this service ever deletes a reward_redemption_entry row).',
      );
    }
    return updated;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
