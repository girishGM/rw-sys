/**
 * T-048 — Zone 3 (10-AI-CAMPAIGN-AGENT.md §2), and the single most important file in this module.
 *
 * > ### The agent no longer generates and executes SQL. It calls the portal's own campaign API.
 * >
 * > *"Routing the agent through `POST /api/v1/campaigns` means it **inherits every guard for
 * > free**, and — critically — a bug in the agent cannot produce a campaign a human maker could not
 * > have produced by hand."*
 *
 * This file replaces `sql-generator.tool.ts`, `sql-executor.tool.ts` and `statement-firewall.ts`,
 * which are deleted rather than ported (§1). There is **no SQL in this module at all** (TC-4,
 * Verification step 2) and no database write path that does not pass through the services below
 * (TC-5).
 *
 * ### "API client" that makes no HTTP call — why, and why it is not a shortcut
 *
 * §2's diagram names Zone 3 as *"the SAME calls a human maker makes"*, carried *"with the MAKER'S
 * OWN SESSION, not a service account"*. This client satisfies both by invoking `CampaignsService`,
 * `JourneyService`, `BindingsService` and `CapsService` **in the maker's own request**, which is
 * exactly what `CampaignsController` does one layer up. That is stronger than a loopback HTTP call,
 * not weaker:
 *
 *  - **The same guards run.** `assertRole(actor, 'maker')` is at the top of every mutating service
 *    method — `assert-role.ts`'s own header says why it lives there rather than in the controller:
 *    *"In the controller it would be a fourth copy of the guard layer, bypassed by any other
 *    caller of the service — **the AI agent backend (T-048)**, a future CLI, a queue consumer. In
 *    the service it holds for all of them."* This file is the caller that sentence was written
 *    about.
 *  - **The same scope runs.** `ScopedRepository` reads the `AsyncLocalStorage` context established
 *    by `TenancyScopeInterceptor` from the verified JWT. An in-process call inherits it; nothing
 *    here can supply, override or widen it.
 *  - **A loopback call would be weaker.** It would need the maker's cookie and CSRF token
 *    forwarded from this process — i.e. this module handling session credentials — and would open
 *    a second, self-addressed trust path that a misconfigured reverse proxy could expose. The
 *    guard chain gained nothing, and the attack surface grew.
 *
 * `campaigns.module.ts`'s own header already anticipated this: *"the AI agent must go through
 * `CampaignsService` rather than reaching the database itself — the agent drafts a plan, a human
 * confirms, and *this* code executes it."*
 *
 * ### The agent stops at `draft` (§3.2, TC-16)
 *
 * There is **no method on this class that submits**. `CampaignsService.submit` is never imported
 * here, `campaignsService.submit` never appears, and `submitForApproval` is not in the tool
 * whitelist (`tool-registry.ts`). *"Submitting for approval is a deliberate human act, and the
 * checker must know a human maker stood behind it."*
 *
 * ### Failure part-way through
 *
 * A plan is executed as a sequence of the wizard's own calls, each atomic in itself. If step 4
 * fails, steps 1–3 have committed and the maker is left with a partial draft — **exactly** what
 * happens to a human maker whose browser dies between wizard steps, and the wizard is where they
 * pick it up. The alternative, one giant transaction spanning every service, would mean this
 * module re-implementing transaction control that `CampaignsService` owns, and would make the
 * agent's write path structurally different from the wizard's. The campaign id is returned even on
 * partial failure for exactly that reason — see {@link PartialPlanExecutionError}.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '@/common/errors/app-error';
import { redactForLog } from '@/common/logging/redact';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { CampaignsService } from '@/modules/campaigns/campaigns.service';
import { JourneyService } from '@/modules/campaigns/journey.service';
import { BindingsService } from '@/modules/campaigns/bindings.service';
import { CapsService } from '@/modules/campaigns/caps.service';
import type { AgentPlan, Campaign } from '@reward-portal/shared';
import { CREATED_VIA_AI_AGENT } from './agent.constants';

/**
 * A plan that was partly applied.
 *
 * Carries the campaign id so the caller can still record the session's outcome and hand the maker
 * a link to the draft. Losing the id would leave an orphan draft nobody could find, which is a
 * worse failure than the one that caused it.
 */
export class PartialPlanExecutionError extends AppError {
  constructor(
    readonly campaignId: number,
    readonly step: string,
    cause: unknown,
  ) {
    super('AGENT_PLAN_PARTIALLY_APPLIED', 502, {
      cause,
      logMessage: `The agent's plan failed at "${step}"; campaign ${campaignId} exists as a partial draft`,
      logContext: { campaignId, step },
    });
  }
}

@Injectable()
export class PortalApiClient {
  private readonly logger = new Logger(PortalApiClient.name);

  constructor(
    private readonly campaigns: CampaignsService,
    private readonly journey: JourneyService,
    private readonly bindings: BindingsService,
    private readonly caps: CapsService,
  ) {}

  /**
   * §5 `createCampaignDraft` — *"calls the portal API as the maker; requires a matching plan
   * hash"*.
   *
   * The hash check happens in `agent.orchestrator.ts` before this is reached; by the time execution
   * starts, the plan is the one the maker approved. The order below is the wizard's own step order
   * (04-FRONTEND.md §5), because each step's validation depends on the previous one having run:
   * an activity is only offerable once merchants are set (T-037 note 8), a rule only bindable once
   * a component exists, a cap only checkable once there is a campaign to scope it to.
   */
  async createCampaignDraft(
    actor: AuthenticatedUser,
    plan: AgentPlan,
    sessionId: string,
  ): Promise<Campaign> {
    // Step 1. `assertRole(actor, 'maker')` fires inside; `tenantId`/`createdBy` come from scope.
    const campaign = await this.campaigns.create(
      actor,
      {
        campaignCode: plan.campaign.campaignCode,
        name: plan.campaign.name,
        ...(plan.campaign.description === null ? {} : { description: plan.campaign.description }),
        startDate: plan.campaign.startDate,
        endDate: plan.campaign.endDate,
        ...(plan.campaign.budgetAmount === null
          ? {}
          : { budgetAmount: plan.campaign.budgetAmount }),
        ...(plan.campaign.budgetCurrency === null
          ? {}
          : { budgetCurrency: plan.campaign.budgetCurrency }),
      },
      // §7 / TC-3 — the provenance a checker reads. See `CampaignsService.create`'s own parameter
      // documentation for why this is a separate argument rather than a DTO field.
      { createdVia: CREATED_VIA_AI_AGENT, agentSessionId: sessionId },
    );

    await this.runStep(campaign.id, 'merchants', async () => {
      await this.campaigns.setMerchants(actor, campaign.id, {
        merchantIds: plan.merchants.map((merchant) => merchant.merchantId),
      });
    });

    // Steps 3–5 need the loaded row rather than the DTO: `JourneyService` and `BindingsService`
    // take a `TenantCampaign`, and loading it through `loadEditableCampaign` re-applies both the
    // scope check and the "still editable" check on every call — the same two checks the
    // controller performs for a human.
    const trackerId = await this.runStep(campaign.id, 'tracker', async () => {
      const row = await this.campaigns.loadEditableCampaign(campaign.id);
      const tracker = await this.journey.createTracker(actor, row, {
        name: plan.tracker.name,
        completionLogic: plan.tracker.completionLogic,
        ...(plan.tracker.completionThreshold === null
          ? {}
          : { completionThreshold: plan.tracker.completionThreshold }),
      });
      return tracker.id;
    });

    const componentIds: number[] = [];
    for (const [index, component] of plan.components.entries()) {
      const componentId = await this.runStep(campaign.id, `component[${index}]`, async () => {
        const row = await this.campaigns.loadEditableCampaign(campaign.id);
        const created = await this.journey.createComponent(actor, row, trackerId, {
          name: component.name,
          activityId: component.activityId,
        });
        return created.component.id;
      });
      componentIds.push(componentId);

      for (const [ruleIndex, rule] of component.rules.entries()) {
        await this.runStep(campaign.id, `component[${index}].rule[${ruleIndex}]`, async () => {
          const row = await this.campaigns.loadEditableCampaign(campaign.id);
          // `values` is re-validated against the **pinned version's** parameter schema inside
          // `bindRule` (T-037 note 9). Nothing this module did to those values is trusted.
          await this.bindings.bindRule(actor, row, {
            componentId,
            ruleId: rule.ruleId,
            values: rule.values,
          });
        });
      }
    }

    for (const [index, reward] of plan.rewards.entries()) {
      await this.runStep(campaign.id, `reward[${index}]`, async () => {
        const row = await this.campaigns.loadEditableCampaign(campaign.id);
        const refId =
          reward.level === 'tracker'
            ? trackerId
            : reward.level === 'component' && reward.componentIndex !== null
              ? componentIds[reward.componentIndex]
              : undefined;
        await this.bindings.attachReward(actor, row, {
          level: reward.level,
          ...(refId === undefined ? {} : { refId }),
          rewardPolicyId: reward.rewardPolicyId,
        });
      });
    }

    if (plan.caps.length > 0) {
      await this.runStep(campaign.id, 'caps', async () => {
        const row = await this.campaigns.loadEditableCampaign(campaign.id);
        // `confirmCurrencyMismatch` is deliberately **not** set. TC-21bb makes a cap in a
        // different currency from the campaign's require one explicit human acknowledgement, and
        // an agent asserting that acknowledgement on the maker's behalf would be the agent
        // consenting to something on their behalf. If the plan contains such a cap, this call
        // fails and the maker is told — which is the correct outcome.
        await this.caps.put(actor, row, { caps: [...plan.caps] });
      });
    }

    // Deliberately **not** `this.campaigns.submit(...)`. See this file's header (TC-16).
    return this.campaigns.getById(campaign.id);
  }

  /**
   * Runs one step, converting any failure into a {@link PartialPlanExecutionError} that still names
   * the campaign.
   *
   * The original error is kept as `cause` and logged (redacted), so the operator sees the real
   * reason — a 400 from a rule value, a 409 from a duplicate reward — while the maker sees one
   * consistent "this could not be finished, here is your draft" outcome.
   */
  private async runStep<T>(
    campaignId: number,
    step: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.logger.error(
        `Agent plan failed at "${step}" for campaign ${campaignId}: ` +
          JSON.stringify(redactForLog({ message: (error as Error).message })),
        (error as Error).stack,
      );
      throw new PartialPlanExecutionError(campaignId, step, error);
    }
  }
}
