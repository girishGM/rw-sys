/**
 * T-RAP-031. The real `ActivityLogRowHandler` (`activity-log-row.handler.ts`) —
 * `05-PROCESSING-PIPELINE.md` §3-§5, steps 1-3: advisory lock, rule evaluation, progress-counter
 * upsert, all inside one transaction. Bound to `ACTIVITY_LOG_ROW_HANDLER` in `processing.module.ts`
 * in place of `NoopActivityLogRowHandler` (that file's own header names this task as the one
 * expected to do so).
 *
 * **This is the one orchestration point T-RAP-032/033/034 (same owning agent, same directory file
 * scope) extend** — `05-PROCESSING-PIPELINE.md` §6's own "still inside the same transaction/
 * advisory-lock scope T-RAP-031 opened" / "this is a continuation of that same unit of work, not a
 * separate claim/lock cycle" applies to every later step in the pipeline. This task's own Scope
 * "Out" stops at "the component just completed" — no tracker-level aggregation, no reward
 * eligibility — so the extension point was a single, clearly marked comment inside `handle()`
 * below, not a separate hook/interface (there is nothing for a later task to conditionally call
 * *around*; it simply continues writing to the same `transaction` before this method returns).
 *
 * **T-RAP-032 update:** that extension point is now filled in — when the component-level write
 * above just completed a component, this method also continues, same transaction, into
 * `TrackerStatusRepository.upsertOnComponentCompletion` (`05-PROCESSING-PIPELINE.md` §5 point 2).
 *
 * **T-RAP-033 update:** the reward-eligibility extension point is now filled in too —
 * `resolveRewardAssignments` (below) resolves every `BoundReward` bound to the component that just
 * completed (always) and, if the tracker itself also just completed this same activity, every
 * `BoundReward` bound to that tracker or to the campaign as a whole
 * (`05-PROCESSING-PIPELINE.md` §6 point 1's own "bound to this component (or its tracker, or its
 * campaign)" — there is no separate "campaign completion" event in this pipeline, so a
 * campaign-level reward is triggered by the same tracker-completion instant a tracker-level one
 * is; flagged in the completion report as this task's own reasonable reading of an otherwise
 * unspecified case). `CapEnforcementService.enforceForCompletion` then reserves-or-denies each one
 * (§6 point 2), still inside this same transaction/advisory lock. A denial on *any* assignment
 * flips this row's own final status to `'error'` (§6 point 2's own "the activity_logs row is
 * finished as error" — a correction to `markProcessed`'s previous unconditional `'processed'`,
 * which predates this task and never had a breach path to report through); a sibling assignment
 * with headroom still reserves normally regardless (T-RAP-033's own TC-4).
 *
 * **T-RAP-034 update:** the final extension point is filled in too — every `capOutcome.granted`
 * assignment now actually inserts its `reward_entry` + `reward_entry_outbox` row
 * (`RewardEntryRepository`/`RewardEntryOutboxRepository`), still inside this same transaction/
 * advisory lock, exactly the "same transaction, same commit" `05-PROCESSING-PIPELINE.md` §6 point 3
 * requires. `rewardEntryDate` is computed once, here, and threaded through to both
 * `CapEnforcementService.enforceForCompletion` (the period-bucket boundary) and the reward_entry
 * insert itself — never re-read mid-transaction (§6 point 2's own discipline, previously only
 * half-applied since nothing downstream of cap enforcement consumed the same value yet).
 * `completionCycle` comes from `progressRepository.upsertOnPassingActivity`'s own returned row —
 * the exact cycle number T-RAP-031's progress upsert just wrote, never independently recomputed.
 * See `reward-entry.repository.ts`'s own header for a flagged, real schema-level gap this task
 * found and worked around defensively rather than silently redesigning (R10): more than one
 * granted assignment on the same completion can collide on `uc_reward_entry_completion`, which
 * carries no reward discriminator.
 *
 * **Not wired into `AppModule`** — same convention every prior Wave 2/3 module has set (nothing
 * transport-facing consumes it yet); `ActivityLogClaimWorker` (T-RAP-030) is the only current
 * caller, via the `ACTIVITY_LOG_ROW_HANDLER` DI token.
 *
 * **T-RAP-059 update:** the three completion-time metrics `06-CONFIGURABILITY-AND-OBSERVABILITY.md`
 * §3 documents are wired in here, at the exact call sites that observe each event first-hand —
 * `tracker_components_completed_total{campaign_code}` the instant `progressResult.justCompleted`
 * is true, `rewards_created_total{campaign_code,reward_category}` once per `reward_entry` row this
 * method actually inserts, and `budget_breach_total{campaign_code,cap_type}` once per
 * `capOutcome.denied` entry — `cap_type` read from `cap-enforcement.service.ts`'s own
 * `deriveCapKey(denied.cap)` rather than re-derived a second, possibly-diverging way. `markProcessed`'s
 * own `Logger.debug` call is replaced with a `StructuredLogger` entry carrying
 * `correlationId`/`tenantId`/`campaignCode` as separate fields (T-RAP-043's own contract) — the
 * plain `Logger` field above is kept only because `resolveAdvisoryLockWaitTimeoutMs` (a shared
 * `processing.config.ts` helper also used by `activity-log-claim.worker.ts`) is typed against the
 * concrete Nest `Logger`, not `StructuredLogger`.
 *
 * **T-RAP-062 update:** the `reward_entry` insert beside the `rewardCategory` assignment above also
 * stamps `reward_kind`/`promo_code_config_id`/`promo_code_config_version_no`, read straight off the
 * same already-resolved `granted.reward` (`BoundReward`, T-173/T-RAP-065) — purely descriptive
 * metadata (`reward-entry.model.ts`'s own header), never a new cap/budget enforcement input, never
 * changing any existing field's own value.
 *
 * **T-INT-060 update (sibling-tracker-component exclusivity).** Fixes a real correctness bug: one
 * activity fanning out to N sibling `tracker_components` under the *same* tracker, all bound to
 * the identical `activityId` (the "buy N times to complete a streak" shape —
 * `05-PROCESSING-PIPELINE.md` §1 is silent on this specific case, a genuine spec gap, not a
 * deviation from spec — see this task's own file for the full live-evidence writeup). Before
 * `RuleEvaluatorService.evaluate()` is ever called for a claimed row, `resolveSiblingTarget` below
 * decides whether *this* row's own component is the one sibling allowed to advance, using two
 * checks, in order:
 *  1. **Has this exact real-world activity submission already advanced a different sibling?**
 *     Every row one submission fans out to shares an identical `activity_logs.dedup_key`
 *     (`activity-ingestion.service.ts`'s own header — computed once, reused verbatim for every
 *     matched row). `TrackerComponentProgressRepository.findSiblingAdvancedByDedupKey` answers this
 *     directly; if it finds a match, that sibling — not a fresh recomputation — is the target. This
 *     check exists specifically because, without it, each subsequent sibling row from the *same*
 *     submission would legitimately look like "the new lowest incomplete slot" the instant the
 *     previous sibling row committed, cascading every sibling through in one submission — the exact
 *     shape of bug this task fixes, just one layer deeper; caught by this task's own TC-1 during
 *     implementation (see completion report).
 *  2. **Otherwise, the lowest-`sequenceOrder` sibling whose latest-cycle progress is not yet
 *     `is_completed`** (`TrackerComponentProgressRepository.isLatestCycleComplete`) — the ordinary
 *     "which slot is next" computation, covering a *different*, later submission advancing the next
 *     slot once an earlier submission's own advance has already committed.
 * A row whose own component is not the resolved target is marked `'processed'` immediately, with a
 * comment naming the real target and which of the two reasons applied, and never reaches rule
 * evaluation or touches progress at all — so only one sibling can ever advance per real-world
 * activity, regardless of which of the N fanned-out rows `ActivityLogClaimWorker` happens to claim
 * first (both checks always read current, committed state at the moment each row is actually
 * handled, inside the same advisory-lock-guarded transaction this method already opens — never
 * assumed from `sequence_order` alone). The common case — a tracker whose components are bound to
 * *distinct* activities — has no siblings to resolve and is completely unaffected
 * (`resolveSiblingTarget` returns immediately). Fan-out itself
 * (`ActivityIngestionService`/`CampaignConfigCacheService`) is unchanged — all N rows are still
 * created; this only gates which one is allowed to reach evaluation.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Sequelize, Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import { CampaignConfigCacheService } from '@/modules/campaign-cache/campaign-config-cache.service';
import type {
  BoundRewardProto,
  BoundRuleProto,
  TrackerComponentProto,
  TrackerProto,
} from '@/modules/campaign-cache/campaign-config.client';
import { ServiceConfigResolverService } from '@/modules/service-config/service-config-resolver.service';
import { CapEnforcementService, deriveCapKey } from '@/modules/budget/cap-enforcement.service';
import { RewardEntryRepository } from '@/modules/reward-entry/reward-entry.repository';
import { RewardEntryOutboxRepository } from '@/modules/reward-entry/reward-entry-outbox.repository';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLogger, StructuredLoggerFactory } from '@/observability/structured-logger';
import { acquireCustomerCampaignAdvisoryLock } from './advisory-lock.util';
import { PROCESSING_SEQUELIZE } from './activity-log-claim.repository';
import type { ActivityLogRowHandler } from './activity-log-row.handler';
import {
  type AdvisoryLockTimeoutResolver,
  resolveAdvisoryLockWaitTimeoutMs,
} from './processing.config';
import { RuleEvaluatorService } from './rule-evaluator.service';
import { TrackerComponentProgressRepository } from './tracker-component-progress.repository';
import { TrackerStatusRepository } from './tracker-status.repository';

type ActivityLogRowStatus = 'processed' | 'error';

/** T-INT-060: `resolveSiblingTarget`'s own result — which sibling component is allowed to advance
 * from this row's own activity, and why, so `handle()` can report an accurate skip comment. */
interface SiblingTargetResolution {
  componentCode: string;
  /** `true` when the target was resolved because this exact real-world activity submission
   * (shared `dedup_key`) already advanced this sibling; `false` when it was resolved as the
   * ordinary lowest-`sequenceOrder`-not-yet-completed slot (including the no-siblings no-op case). */
  alreadyAdvancedThisActivity: boolean;
}

@Injectable()
export class RuleEvaluationRowHandler implements ActivityLogRowHandler {
  private readonly logger = new Logger(RuleEvaluationRowHandler.name);
  private readonly structuredLogger: StructuredLogger;

  constructor(
    @Inject(PROCESSING_SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cache: CampaignConfigCacheService,
    private readonly ruleEvaluator: RuleEvaluatorService,
    private readonly progressRepository: TrackerComponentProgressRepository,
    private readonly trackerStatusRepository: TrackerStatusRepository,
    @Inject(ServiceConfigResolverService)
    private readonly configResolver: AdvisoryLockTimeoutResolver,
    private readonly capEnforcement: CapEnforcementService,
    private readonly rewardEntryRepository: RewardEntryRepository,
    private readonly rewardEntryOutboxRepository: RewardEntryOutboxRepository,
    private readonly metrics: MetricsService,
    loggers: StructuredLoggerFactory,
  ) {
    this.structuredLogger = loggers.forContext(RuleEvaluationRowHandler.name);
  }

  /**
   * One claimed (`status = 'processing'`) row, one transaction. `05-PROCESSING-PIPELINE.md` §3:
   * "If any step in the transaction fails (a genuine error, not a business-rule 'reward not
   * earned' outcome), the whole transaction rolls back" — this method deliberately lets a genuine
   * error (an unresolvable cached campaign/tracker/component, a malformed rule expression, a lock
   * timeout) propagate rather than catching it: `ActivityLogClaimWorker.claimAndHandleOne()`
   * (T-RAP-030) already catches/logs whatever this throws and leaves the row `processing` for
   * `StaleProcessingSweepService` to reclaim, exactly the recovery path `activity-log-row.handler.ts`'s
   * own header documents.
   */
  async handle(row: ActivityLogRow): Promise<void> {
    await this.sequelize.transaction(async (transaction) => {
      await acquireCustomerCampaignAdvisoryLock(this.sequelize, transaction, {
        tenantId: row.tenant_id,
        customerIdHash: row.customer_id_hash,
        campaignCode: row.campaign_code,
        waitTimeoutMs: resolveAdvisoryLockWaitTimeoutMs(
          this.configResolver,
          { campaignCode: row.campaign_code, tenantId: row.tenant_id },
          this.logger,
        ),
      });

      const { tracker, component, ruleRefs } = this.resolveTrackerContext(row);

      // T-INT-060: gate fan-out siblings sharing one activity binding under the same tracker —
      // see this file's own header. A no-op (returns `component.componentCode` immediately) for
      // the common case of a component with no such siblings.
      const siblingTarget = await this.resolveSiblingTarget(transaction, row, tracker, component);
      if (siblingTarget.componentCode !== component.componentCode) {
        const comment = siblingTarget.alreadyAdvancedThisActivity
          ? `Sibling component "${siblingTarget.componentCode}" already advanced from this same ` +
            `activity; activity did not advance component "${component.componentCode}".`
          : `Sibling component "${siblingTarget.componentCode}" is this tracker's current pending ` +
            `slot; activity did not advance component "${component.componentCode}".`;
        await this.markProcessed(transaction, row, 'processed', comment);
        return;
      }

      const outcome = this.ruleEvaluator.evaluate(row, ruleRefs);

      if (!outcome.passed) {
        await this.markProcessed(transaction, row, 'processed', outcome.comment);
        return;
      }

      const requiredCount = this.ruleEvaluator.resolveRequiredCount(ruleRefs);
      const progressResult = await this.progressRepository.upsertOnPassingActivity(transaction, {
        tenantId: row.tenant_id,
        customerIdHash: row.customer_id_hash,
        campaignCode: row.campaign_code,
        trackerCode: row.tracker_code,
        trackerComponentCode: row.tracker_component_code,
        requiredCount,
        activityLogId: row.id,
      });

      let comment = progressResult.justCompleted
        ? `All bound rules passed; component "${row.tracker_component_code}" reached its required count and is now complete.`
        : 'All bound rules passed; progress incremented.';
      let finalStatus: ActivityLogRowStatus = 'processed';

      if (progressResult.justCompleted) {
        // T-RAP-059: `tracker_components_completed_total{campaign_code}` — incremented exactly when
        // this component's own completion is observed, before any downstream tracker/reward step
        // (06-CONFIGURABILITY-AND-OBSERVABILITY.md §3).
        this.metrics.incrementTrackerComponentsCompleted(row.campaign_code);

        // T-RAP-032: "if the component just completed, upsert `customer_tracker_status` ...
        // evaluate the tracker's own `completion_logic`" (`05-PROCESSING-PIPELINE.md` §5 point 2)
        // — same transaction, same advisory lock, a direct continuation of this call.
        const trackerStatus = await this.trackerStatusRepository.upsertOnComponentCompletion(
          transaction,
          {
            tenantId: row.tenant_id,
            customerIdHash: row.customer_id_hash,
            campaignCode: row.campaign_code,
            trackerCode: row.tracker_code,
            completionLogic: tracker.completionLogic,
            completionThreshold: tracker.completionThreshold,
            componentsRequiredCount: (tracker.components ?? []).length,
          },
        );

        if (trackerStatus.justCompleted) {
          comment += ` Tracker "${row.tracker_code}" reached its completion_logic ("${tracker.completionLogic}") and is now complete.`;
        }

        // T-RAP-033: reward eligibility and budget/cap enforcement (`05-PROCESSING-PIPELINE.md`
        // §6), still inside this same `transaction`/advisory lock — see this file's own header
        // for the exact trigger rule (`resolveRewardAssignments` below).
        const cached = this.cache.getCampaignConfig(row.tenant_id, row.campaign_code);
        const assignments = this.resolveRewardAssignments(
          cached?.raw.rewards ?? [],
          component,
          tracker,
          trackerStatus.justCompleted,
        );
        if (assignments.length > 0) {
          // Computed once, threaded through to both the cap-enforcement period-bucket boundary and
          // the reward_entry insert below — never re-read mid-transaction (§6 point 2's own
          // discipline, this file's own header).
          const rewardEntryDate = new Date();
          const capOutcome = await this.capEnforcement.enforceForCompletion(transaction, {
            correlationId: row.correlation_id,
            tenantId: row.tenant_id,
            campaignId: cached?.raw.campaignId ?? 0,
            campaignCode: row.campaign_code,
            customerIdHash: row.customer_id_hash,
            trackerId: tracker.trackerId,
            rewardEntryDate,
            assignments,
            caps: cached?.raw.caps ?? [],
          });

          if (capOutcome.denied.length > 0) {
            finalStatus = 'error';
            comment += ` ${capOutcome.denied.map((d) => d.comment).join(' ')}`;
            // T-RAP-059: `budget_breach_total{campaign_code,cap_type}` — one increment per denied
            // assignment, `cap_type` read from `deriveCapKey` (the same derivation
            // `cap-enforcement.service.ts` itself already uses to key `budget_consumption`/
            // `customer_reward_limit_consumption`) rather than re-derived a second way here.
            for (const denied of capOutcome.denied) {
              this.metrics.incrementBudgetBreach(
                row.campaign_code,
                deriveCapKey(denied.cap).capType,
              );
            }
          }
          if (capOutcome.granted.length > 0) {
            // T-RAP-034: `reward_entry` + `reward_entry_outbox`, same transaction, same commit
            // (`05-PROCESSING-PIPELINE.md` §6 point 3) — one row pair per granted assignment.
            const createdRewardCodes: string[] = [];
            for (const granted of capOutcome.granted) {
              const rewardEntry = await this.rewardEntryRepository.insertForGrantedAssignment(
                transaction,
                {
                  row,
                  rewardCode: granted.reward.systemCode,
                  rewardCategory: granted.reward.rewardType,
                  rewardValue: granted.rewardValue,
                  rewardValueUnit: granted.reward.unitCode,
                  completionCycle: progressResult.row.completion_cycle,
                  rewardEntryDate,
                  // T-RAP-062: stamp the three descriptive-only fields read straight off the
                  // already-resolved `BoundReward` (T-173/T-RAP-065) — `||` treats proto3's own
                  // empty-string/zero "absent" encoding as "not yet set/not applicable", never
                  // fabricated, same discipline `rewardCategory` above already follows.
                  rewardKind: granted.reward.rewardKind || null,
                  promoCodeConfigId: granted.reward.promoCodeConfigId || null,
                  promoCodeConfigVersionNo: granted.reward.promoCodeConfigVersionNo || null,
                },
              );
              if (rewardEntry === null) {
                // See reward-entry.repository.ts's own header — a schema-level collision, not a
                // business-rule denial; this row's own progress/budget state still stands.
                continue;
              }
              await this.rewardEntryOutboxRepository.insertPending(transaction, rewardEntry);
              // T-RAP-059: `rewards_created_total{campaign_code,reward_category}` — once per
              // reward_entry row actually inserted (never for a `null` collision result above).
              this.metrics.incrementRewardsCreated(row.campaign_code, granted.reward.rewardType);
              createdRewardCodes.push(granted.reward.systemCode);
            }
            if (createdRewardCodes.length > 0) {
              comment += ` ${createdRewardCodes.length} reward entry(ies) created: ${createdRewardCodes.join(', ')}.`;
            }
          }
        }
      }

      await this.markProcessed(transaction, row, finalStatus, comment);
    });
  }

  /**
   * `05-PROCESSING-PIPELINE.md` §6 point 1: reward assignments bound to the component that just
   * completed are always resolved; if the tracker itself also just completed this same activity,
   * assignments bound to the tracker or to the campaign as a whole are resolved too (see this
   * file's own header for why campaign-level assignments share the tracker-level trigger). A
   * `BoundReward`'s own `status` is not filtered here — the cache (`CampaignConfigCacheService`)
   * is the single place that decides what counts as "currently bound", the same discipline
   * `resolveTrackerContext` already applies to `ruleRefs`.
   */
  private resolveRewardAssignments(
    rewards: readonly BoundRewardProto[],
    component: TrackerComponentProto,
    tracker: TrackerProto,
    trackerJustCompleted: boolean,
  ): BoundRewardProto[] {
    return rewards.filter((reward) => {
      if (reward.level === 'component') {
        return reward.refId === component.componentId;
      }
      if (reward.level === 'tracker') {
        return trackerJustCompleted && reward.refId === tracker.trackerId;
      }
      if (reward.level === 'campaign') {
        return trackerJustCompleted;
      }
      return false;
    });
  }

  /**
   * T-INT-060. `tracker.components` (the raw, unfiltered cache payload — `resolveTrackerContext`'s
   * own header documents why `cached.raw` is read directly) may hold several **active** siblings
   * of `component`, under the same `tracker`, bound to the identical `activityId` — the "buy N
   * times" streak shape this task fixes. Returns the `componentCode` of the one sibling (possibly
   * `component` itself) that is this tracker's current pending slot: the lowest-`sequenceOrder`
   * sibling whose own latest-cycle progress row is not yet `is_completed`, read via
   * `TrackerComponentProgressRepository.isLatestCycleComplete` — inside the same transaction/
   * advisory-lock scope `handle()` already opened, so this is always a read of committed state as
   * of the moment *this* row is actually handled, never a stale snapshot from fan-out time and
   * never dependent on which sibling row was claimed first (two sibling rows for the same
   * customer+campaign can never run this concurrently — the advisory lock serializes them).
   *
   * A component with no such siblings (the common case — most trackers bind distinct activities to
   * distinct components) short-circuits (`{ componentCode: component.componentCode, alreadyAdvancedThisActivity: false }`),
   * a pure no-op.
   *
   * Two checks, in order — see this file's own header for the full "why":
   *  1. `findSiblingAdvancedByDedupKey`: has *this exact* real-world activity submission (shared
   *     `dedup_key` across every fanned-out sibling row) already advanced a different sibling? If
   *     so, that sibling is the target, `alreadyAdvancedThisActivity: true` — never recomputed from
   *     `sequence_order`, because doing so would let every later sibling row of the *same*
   *     submission cascade through right behind the one that already advanced.
   *  2. Otherwise, the lowest-`sequenceOrder` sibling whose latest-cycle progress is not yet
   *     `is_completed` (`isLatestCycleComplete`) — a *different*, later submission's own "which slot
   *     is next" computation. If every sibling's latest cycle is already complete (e.g. a repeatable
   *     tracker that has already finished one full pass), falls back to the lowest-`sequenceOrder`
   *     sibling — the same "start the next cycle" behavior
   *     `TrackerComponentProgressRepository.upsertOnPassingActivity` already applies to a single,
   *     non-sibling component (its own `insertNewCycle` branch); this task's own test cases don't
   *     exercise a second full pass, so this is a documented, reasonable extrapolation rather than a
   *     directly-specified case — flagged in the completion report.
   */
  private async resolveSiblingTarget(
    transaction: Transaction,
    row: ActivityLogRow,
    tracker: TrackerProto,
    component: TrackerComponentProto,
  ): Promise<SiblingTargetResolution> {
    const siblings = (tracker.components ?? []).filter(
      (candidate) => candidate.status === 'active' && candidate.activityId === component.activityId,
    );
    if (siblings.length <= 1) {
      return { componentCode: component.componentCode, alreadyAdvancedThisActivity: false };
    }
    const bySequence = [...siblings].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
    const siblingComponentCodes = bySequence.map((candidate) => candidate.componentCode);

    const advancedBy = await this.progressRepository.findSiblingAdvancedByDedupKey(transaction, {
      tenantId: row.tenant_id,
      customerIdHash: row.customer_id_hash,
      campaignCode: row.campaign_code,
      trackerCode: row.tracker_code,
      siblingComponentCodes,
      dedupKey: row.dedup_key,
    });
    if (advancedBy !== null) {
      return { componentCode: advancedBy, alreadyAdvancedThisActivity: true };
    }

    for (const candidate of bySequence) {
      const isComplete = await this.progressRepository.isLatestCycleComplete(transaction, {
        tenantId: row.tenant_id,
        customerIdHash: row.customer_id_hash,
        campaignCode: row.campaign_code,
        trackerCode: row.tracker_code,
        trackerComponentCode: candidate.componentCode,
      });
      if (!isComplete) {
        return { componentCode: candidate.componentCode, alreadyAdvancedThisActivity: false };
      }
    }
    return { componentCode: bySequence[0].componentCode, alreadyAdvancedThisActivity: false };
  }

  /**
   * Resolves the claimed row's own cached `TrackerProto` and the `BoundRuleProto`s bound to its
   * tracker component (`trackerComponentId` match, `03-GRPC-CONTRACT.md` §2) — reads
   * `CampaignConfigCacheService` exclusively, never `campaign_config_snapshot` directly, same
   * discipline `ActivityMapper` (T-RAP-021) already established for this service's Wave 2/3 read
   * path. A campaign/tracker/component this service can no longer find in the cache (invalidated
   * between fan-out and this claim) is a genuine error, not a "rule didn't pass" outcome — see
   * `handle()`'s own header.
   */
  private resolveTrackerContext(row: ActivityLogRow): {
    tracker: TrackerProto;
    component: TrackerComponentProto;
    ruleRefs: readonly BoundRuleProto[];
  } {
    const cached = this.cache.getCampaignConfig(row.tenant_id, row.campaign_code);
    if (!cached) {
      throw new Error(
        `No cached campaign config for tenant ${row.tenant_id} campaign "${row.campaign_code}" ` +
          `— cannot evaluate rules for activity_logs row ${row.id}.`,
      );
    }
    const tracker = (cached.raw.trackers ?? []).find((t) => t.trackerCode === row.tracker_code);
    const component = tracker?.components?.find(
      (c) => c.componentCode === row.tracker_component_code,
    );
    if (!tracker || !component) {
      throw new Error(
        `Cached campaign config for "${row.campaign_code}" has no active tracker/component ` +
          `matching "${row.tracker_code}"/"${row.tracker_component_code}" (activity_logs row ${row.id}).`,
      );
    }
    const ruleRefs = (cached.raw.rules ?? []).filter(
      (rule) => rule.trackerComponentId === component.componentId,
    );
    return { tracker, component, ruleRefs };
  }

  /**
   * `status` is `'error'` only when T-RAP-033's own cap enforcement denied at least one reward
   * assignment on this completion (`05-PROCESSING-PIPELINE.md` §6 point 2) — every other outcome
   * (a rule that simply didn't pass, a component that only partially progressed, a completion with
   * no bound rewards at all) is `'processed'`, same as before this task.
   */
  private async markProcessed(
    transaction: Transaction,
    row: ActivityLogRow,
    status: ActivityLogRowStatus,
    comment: string,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE realtime_activity_processing.activity_logs
          SET status = :status,
              activity_processed_date = now(),
              comment = :comment,
              updated_at = now()
        WHERE id = :id`,
      { type: QueryTypes.RAW, transaction, replacements: { id: row.id, status, comment } },
    );
    // T-RAP-059: StructuredLogger, not the plain Nest `Logger` this line used before —
    // correlationId/tenantId/campaignCode as separate JSON fields
    // (06-CONFIGURABILITY-AND-OBSERVABILITY.md §3), not string-interpolated.
    this.structuredLogger.debug(`activity_logs row ${row.id} ${status}: ${comment}`, {
      correlationId: row.correlation_id,
      tenantId: row.tenant_id,
      campaignCode: row.campaign_code,
      activityLogId: row.id,
    });
  }
}
