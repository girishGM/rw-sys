/**
 * T-047 — the six read RPCs of `CampaignConfigService`, in terms of plain objects.
 *
 * The transport lives in `campaign-config.controller.ts`; everything here is decoded requests in
 * and response-shaped objects out, which is what makes the whole surface testable without a socket
 * and what would let `@grpc/grpc-js` replace the hand-rolled transport without touching this file.
 *
 * ### Read-only is structural, not a convention
 *
 * There is no mutating method here and there is no mutating RPC in the proto (TC-13). Every read
 * additionally runs inside `runReadOnly`, so a write issued on this connection during a gRPC call
 * is refused by Postgres itself (TC-14) — see `internal-read.scope.ts` for why that is the form
 * implementation note 1's *"DB role granted SELECT only"* takes here.
 *
 * ### The order of checks, and why it does not vary between methods
 *
 *  1. **rate limit** — cheapest, and the one that must hold even when everything else would fail;
 *     a retry storm against a *denied* tenant is still a retry storm (TC-28).
 *  2. **tenant grant** — `PERMISSION_DENIED` before any query is issued (TC-11).
 *  3. **sections** — `PERMISSION_DENIED` naming the section for an explicit ask (TC-32).
 *  4. **the read**, in one read-only transaction (implementation note 4).
 *
 * Every method funnels through {@link authorise} so that order is written once. A method that
 * checked sections before the tenant would leak, by the shape of the error, whether an identity has
 * *any* grant for a tenant it may not read.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { RewardSystem, RewardVersion, RuleMaster, RuleVersion } from '@/database/models';
import { CONFIG_SECTION, LISTED_CAMPAIGN_STATUS, SERVED_CAMPAIGN_STATUSES } from './grpc.constants';
import { GrpcError, GrpcStatus } from './grpc.errors';
import { configHashOf, etagOf } from './config-hash';
import { ConfigSnapshotBuilder, type ConfigPayload } from './config-snapshot.builder';
import { runAsDefinitionReader, runAsTenant, runReadOnly } from './internal-read.scope';
import { resolveSections, sectionNumber, type SectionResolution } from './section-grant.guard';
import { ServiceScopeGuard, type ResolvedServiceIdentity } from './service-scope.guard';
import { ChangeEventPublisher, changeTypeNumber } from './change-event.publisher';
import { ServiceRateLimiter } from './rate-limit';

/** A `CampaignConfig` as the encoder wants it (camelCase proto field names). */
export type CampaignConfigWire = Record<string, unknown>;

export interface GetCampaignConfigRequest {
  readonly tenantId: number;
  readonly campaignCode: string;
  readonly etag: string;
  readonly sections: readonly number[];
}

export interface ListActiveCampaignsRequest {
  readonly tenantId: number;
  readonly sections: readonly number[];
}

export interface ResolveRuleVersionRequest {
  readonly tenantId: number;
  readonly ruleId: number;
  readonly versionNo: number;
}

export interface ResolveRewardVersionRequest {
  readonly tenantId: number;
  readonly rewardId: number;
  readonly versionNo: number;
}

export interface BudgetStatusRequest {
  readonly tenantId: number;
  readonly campaignCode: string;
}

@Injectable()
export class CampaignConfigService {
  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly scoped: ScopedRepository,
    private readonly builder: ConfigSnapshotBuilder,
    private readonly scopeGuard: ServiceScopeGuard,
    private readonly publisher: ChangeEventPublisher,
    private readonly limiter: ServiceRateLimiter,
  ) {}

  /** Checks 1–3 of the order this file's header fixes. Returns the resolved section set. */
  private authorise(
    caller: ResolvedServiceIdentity,
    tenantId: number,
    requestedSections: readonly number[],
  ): SectionResolution {
    this.limiter.consume(caller.identity);
    const grant = this.scopeGuard.grantFor(caller, tenantId);
    return resolveSections(caller.identity, grant.allowedSections, requestedSections);
  }

  // --- GetCampaignConfig -------------------------------------------------------------------------

  /**
   * TC-1, TC-3…TC-8, TC-16, TC-17, TC-30…TC-35.
   *
   * A campaign that is `draft`, `pending_approval`, `completed` or `archived` is **not served**
   * (§6, TC-4/TC-5) and is reported as `NOT_FOUND` — the same answer as a campaign code that does
   * not exist, because to this caller they are the same thing: there is no configuration to apply.
   * `paused` **is** served, with the flag, so the runtime stops accruing rather than erroring on a
   * campaign that vanished from its cache (TC-6).
   *
   * `CampaignConfig` has no `exists` field, so `NOT_FOUND` is the only signal available here;
   * `ResolveRuleVersion`'s `exists: false` (§5) is a different case with a field for it.
   */
  async getCampaignConfig(
    caller: ResolvedServiceIdentity,
    request: GetCampaignConfigRequest,
  ): Promise<{ config: CampaignConfigWire; sections: SectionResolution }> {
    const sections = this.authorise(caller, request.tenantId, request.sections);

    const built = await runReadOnly(this.sequelize, async (transaction) =>
      runAsTenant(request.tenantId, null, async () => {
        const campaign = await this.builder.findCampaign(request.campaignCode, transaction);
        if (campaign === null || !SERVED_CAMPAIGN_STATUSES.includes(campaign.status)) {
          throw new GrpcError(
            GrpcStatus.NOT_FOUND,
            `no active or paused campaign "${request.campaignCode}" for tenant ${request.tenantId}`,
          );
        }
        const countryId = await this.builder.countryOf(campaign, transaction);
        // The country is only knowable after the campaign is loaded, and the five definition
        // tables need it — so the tenant scope is re-entered with it rather than guessed up front.
        return runAsTenant(request.tenantId, countryId, () =>
          this.builder.build(campaign, countryId, sections, transaction),
        );
      }),
    );

    return { config: this.toWire(built, sections, request.etag), sections };
  }

  // --- ListActiveCampaigns -----------------------------------------------------------------------

  /**
   * TC-15, TC-25. Every **active** campaign of the tenant, scope-bounded, used to warm the runtime
   * cache at boot and to re-warm after a dropped stream.
   *
   * `paused` campaigns are deliberately **not** listed: the method is named for what it returns,
   * and a cache warmed with paused campaigns would accrue nothing while occupying an entry. A
   * runtime that already holds one keeps it until its TTL and learns about the pause from the
   * stream or from its next `GetCampaignConfig`, which does serve it.
   */
  async listActiveCampaigns(
    caller: ResolvedServiceIdentity,
    request: ListActiveCampaignsRequest,
  ): Promise<{ list: Record<string, unknown>; sections: SectionResolution }> {
    const sections = this.authorise(caller, request.tenantId, request.sections);

    const configs = await runReadOnly(this.sequelize, async (transaction) =>
      runAsTenant(request.tenantId, null, async () => {
        const campaigns = await this.builder.listCampaigns(LISTED_CAMPAIGN_STATUS, transaction);
        const built: CampaignConfigWire[] = [];
        for (const campaign of campaigns) {
          const countryId = await this.builder.countryOf(campaign, transaction);
          const payload = await runAsTenant(request.tenantId, countryId, () =>
            this.builder.build(campaign, countryId, sections, transaction),
          );
          built.push(this.toWire(payload, sections, ''));
        }
        return built;
      }),
    );

    return {
      list: {
        campaigns: configs,
        servedAt: new Date().toISOString(),
        sectionsReturned: sections.returned.map(sectionNumber),
        sectionsOmitted: sections.omitted.map(sectionNumber),
      },
      sections,
    };
  }

  // --- WatchCampaignConfig ------------------------------------------------------------------------

  /**
   * TC-21…TC-25. Subscribes to one tenant's governance transitions.
   *
   * Resolves when the client goes away. Emits nothing on subscribe: a client that has just
   * connected re-warms through `ListActiveCampaigns`, which is the documented recovery path and is
   * correct whether or not it ever received an event (§8).
   */
  async watchCampaignConfig(
    caller: ResolvedServiceIdentity,
    tenantId: number,
    emit: (event: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.limiter.consume(caller.identity);
    this.scopeGuard.grantFor(caller, tenantId);

    await new Promise<void>((resolve) => {
      const unsubscribe = this.publisher.subscribe(tenantId, (event) => {
        emit({
          campaignId: event.campaignId,
          campaignCode: event.campaignCode,
          tenantId: event.tenantId,
          changeType: changeTypeNumber(event.changeType),
          etag: event.etag,
          occurredAt: event.occurredAt,
        });
      });
      const finish = (): void => {
        unsubscribe();
        resolve();
      };
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    });
  }

  // --- ResolveRuleVersion / ResolveRewardVersion ---------------------------------------------------

  /**
   * TC-18, TC-19, TC-20 — the customer-query path (§5).
   *
   * Two behaviours that are the whole point of this RPC:
   *
   *  - **A `retired` version still resolves.** Retirement stops new bindings; it never hides
   *    history. Returning "not found" for a retired version would break every historical record
   *    referencing it.
   *  - **An unknown version returns `exists: false`, not an error status.** A `NOT_FOUND` makes the
   *    caller's error handling fire and usually gets logged as an incident; a clean flag lets a
   *    support tool say *"this version is not recognised"* calmly.
   *
   * `tenant_id` is scoping only — the version itself is global configuration, which is why the
   * lookup runs under the definition-reader scope rather than the tenant's.
   */
  async resolveRuleVersion(
    caller: ResolvedServiceIdentity,
    request: ResolveRuleVersionRequest,
  ): Promise<Record<string, unknown>> {
    this.limiter.consume(caller.identity);
    this.scopeGuard.grantFor(caller, request.tenantId);

    return runReadOnly(this.sequelize, async (transaction) =>
      runAsDefinitionReader(async () => {
        const rules = await this.scoped.listAll(RuleMaster, {
          where: { id: request.ruleId },
          limit: 1,
          transaction,
        });
        const rule = rules[0];
        if (rule === undefined) return { exists: false };

        const versions = await this.scoped.listAll(RuleVersion, {
          where: { ruleId: request.ruleId, versionNo: request.versionNo },
          limit: 1,
          transaction,
        });
        const version = versions[0];
        if (version === undefined) return { exists: false };

        return {
          ruleId: rule.id,
          ruleCode: rule.ruleCode,
          name: rule.name,
          versionNo: version.versionNo,
          expression: version.expression ?? rule.expression ?? '',
          parametersJson: JSON.stringify(version.parameters ?? rule.parameters ?? {}),
          status: version.status,
          publishedAt: version.publishedAt === null ? '' : version.publishedAt.toISOString(),
          changeSummary: version.changeSummary ?? '',
          exists: true,
          ruleVersionId: version.id,
        };
      }),
    );
  }

  /** The reward mirror of {@link resolveRuleVersion}. `connector_config` is absent here too (§6):
   * resolution explains a decision, it does not hand out delivery credentials. */
  async resolveRewardVersion(
    caller: ResolvedServiceIdentity,
    request: ResolveRewardVersionRequest,
  ): Promise<Record<string, unknown>> {
    this.limiter.consume(caller.identity);
    this.scopeGuard.grantFor(caller, request.tenantId);

    return runReadOnly(this.sequelize, async (transaction) =>
      runAsDefinitionReader(async () => {
        const systems = await this.scoped.listAll(RewardSystem, {
          where: { id: request.rewardId },
          limit: 1,
          transaction,
        });
        const system = systems[0];
        if (system === undefined) return { exists: false };

        const versions = await this.scoped.listAll(RewardVersion, {
          where: { rewardId: request.rewardId, versionNo: request.versionNo },
          limit: 1,
          transaction,
        });
        const version = versions[0];
        if (version === undefined) return { exists: false };

        return {
          rewardId: system.id,
          systemCode: system.systemCode,
          name: system.name,
          versionNo: version.versionNo,
          rewardType: system.rewardType,
          deliveryMode: version.deliveryMode ?? system.deliveryMode,
          policiesJson: JSON.stringify(version.policiesSnapshot ?? {}),
          unitType: version.unitType ?? '',
          unitCode: version.unitCode ?? '',
          status: version.status,
          publishedAt: version.publishedAt === null ? '' : version.publishedAt.toISOString(),
          changeSummary: version.changeSummary ?? '',
          exists: true,
          rewardVersionId: version.id,
        };
      }),
    );
  }

  // --- GetBudgetStatus ----------------------------------------------------------------------------

  /**
   * The **configured** ceilings, never a balance.
   *
   * §4b: *"The portal **configures** budgets; the runtime **enforces** them and owns the
   * counters."* This RPC exists so the portal's own screens can show consumption without owning
   * that state, and it returns what the portal knows — the caps — so the runtime can reconcile them
   * against its counters.
   *
   * Guarded by the `CAPS` section grant, because that is what it serves: an identity granted only
   * `REWARDS` cannot read cap ceilings through a differently-named RPC.
   */
  async getBudgetStatus(
    caller: ResolvedServiceIdentity,
    request: BudgetStatusRequest,
  ): Promise<Record<string, unknown>> {
    this.authorise(caller, request.tenantId, [CONFIG_SECTION.CAPS]);

    return runReadOnly(this.sequelize, async (transaction) =>
      runAsTenant(request.tenantId, null, async () => {
        const campaign = await this.builder.findCampaign(request.campaignCode, transaction);
        if (campaign === null || !SERVED_CAMPAIGN_STATUSES.includes(campaign.status)) {
          throw new GrpcError(
            GrpcStatus.NOT_FOUND,
            `no active or paused campaign "${request.campaignCode}" for tenant ${request.tenantId}`,
          );
        }
        const caps = await this.builder.sectionCaps(campaign.id, transaction);
        return {
          campaignId: campaign.id,
          servedAt: new Date().toISOString(),
          entries: caps.map((cap) => ({
            capId: cap.capId,
            capClass: cap.capClass,
            scopeLevel: cap.scopeLevel,
            scopeRefId: cap.scopeRefId,
            periodType: cap.periodType,
            unitType: cap.unitType,
            unitCode: cap.unitCode,
            maxTotalAmount: cap.maxTotalAmount,
            maxOccurrences: cap.maxOccurrences,
            onBreach: cap.onBreach,
            warnAtPercent: cap.warnAtPercent,
          })),
        };
      }),
    );
  }

  // --- shared ------------------------------------------------------------------------------------

  /**
   * The payload plus its hash, etag and the 304 decision.
   *
   * `etag` covers the **section set** as well as the config (§4c trap 1, TC-34) — see
   * `config-hash.ts`. A `not_modified` response carries the identifying header fields and nothing
   * else: enough for a client to know which campaign it is about, no payload to transfer (TC-16).
   */
  private toWire(
    payload: ConfigPayload,
    sections: SectionResolution,
    presentedEtag: string,
  ): CampaignConfigWire {
    const configHash = configHashOf(payload);
    const etag = etagOf(configHash, sections.returned);
    const servedAt = new Date().toISOString();
    const sectionsReturned = sections.returned.map(sectionNumber);
    const sectionsOmitted = sections.omitted.map(sectionNumber);

    if (presentedEtag !== '' && presentedEtag === etag) {
      return {
        campaignId: payload.campaignId,
        campaignCode: payload.campaignCode,
        tenantId: payload.tenantId,
        etag,
        configHash,
        notModified: true,
        servedAt,
        sectionsReturned,
        sectionsOmitted,
      };
    }

    return {
      ...payload,
      etag,
      configHash,
      notModified: false,
      servedAt,
      sectionsReturned,
      sectionsOmitted,
    };
  }
}
