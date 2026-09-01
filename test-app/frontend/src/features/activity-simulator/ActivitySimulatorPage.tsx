/**
 * T-010 — the Activity Simulator page (`/activity`, `ARCHITECTURE.md` §4), replacing `router.tsx`'s
 * T-006 placeholder: the real form (`ActivityForm`), the real per-customer feed (`ActivityFeed`,
 * `GET /api/activities`, T-013), and the reward-landed toast (`RewardToast`) — this demo's
 * centerpiece flow, per this task's own Objective.
 *
 * The toast is driven by `sseBus`'s `reward-earned` event (`lib/sseClient.ts`'s own header:
 * "republishes it on `sseBus` for T-010's toast") — the same one SSE connection every other page
 * already reacts to (`app/Layout.tsx` mounts `useSse` once, app-wide), filtered to the
 * currently-selected customer, rather than a second, page-local update mechanism (this task's
 * implementation notes: "Reuse T-006's SSE wiring"). The inline status line below the form is
 * driven directly by this exact submission's own `POST /api/activities` response instead — it has
 * to cover the "no tracker matched" (TC-5) and "progress updated, no reward" (TC-1) cases too,
 * which never emit a `reward-earned` event at all.
 */
import { useEffect, useRef, useState } from 'react';
import { useCustomer } from '../../app/useCustomer';
import { useActivities, useCampaigns, usePostActivity } from '../../lib/queries';
import { sseBus } from '../../lib/sseClient';
import { Card } from '../../components/Card';
import type { RewardLedgerEntry } from '../../types';
import { ActivityForm, type ActivitySubmitValues } from './ActivityForm';
import { ActivityFeed } from './ActivityFeed';
import { RewardToast } from './RewardToast';
import { useActivityTypeOptions } from './useActivityTypeOptions';

/** Long enough to read + click "View in My Rewards" without feeling rushed, short enough not to
 * clutter the screen through a whole demo session. */
const TOAST_AUTO_DISMISS_MS = 8000;

interface SubmitStatus {
  readonly matched: boolean;
  readonly rewardCount: number;
}

function statusMessage(status: SubmitStatus): string {
  if (status.rewardCount > 0) return 'Reward earned — see the toast for details.';
  if (status.matched) return 'Progress updated — see the feed below.';
  // TC-5: a real, sensible "no progress" message — never a silent no-op and never a false
  // "reward earned".
  return 'No tracker matched this activity — no progress recorded.';
}

export function ActivitySimulatorPage() {
  const { customerId, isLoading: customerLoading } = useCustomer();
  const activitiesQuery = useActivities(customerId);
  const campaignsQuery = useCampaigns(customerId);
  const { options: activityTypeOptions, isLoading: optionsLoading } = useActivityTypeOptions();
  const postActivity = usePostActivity();

  const [toastReward, setToastReward] = useState<RewardLedgerEntry | null>(null);
  const [status, setStatus] = useState<SubmitStatus | null>(null);
  // TC-8: `postActivity.isPending`/`ActivityForm`'s own `disabled` attribute both only take
  // effect on the *next* render — two `click()`s dispatched in the same synchronous tick (found
  // live-verifying this exact task: a real double-click fires as two separate browser tasks and
  // is caught by the disabled attribute in time, but a same-tick double dispatch is not) would
  // otherwise both reach `postActivity.mutate`, minting real duplicate progress. This ref is
  // mutated synchronously, with no render in between, so it closes that gap regardless of how
  // React/React Query happen to schedule their own state updates.
  const submitInFlightRef = useRef(false);

  useEffect(() => {
    if (!customerId) return undefined;
    const handleRewardEarned = (event: Event) => {
      const reward = (event as CustomEvent<RewardLedgerEntry>).detail;
      // `sseBus` is app-wide, one connection for whichever customer is currently selected — this
      // guard is defensive (a stale event from just before a customer switch should never surface
      // as this customer's toast) rather than expected to filter anything out in practice.
      if (reward.customerId !== customerId) return;
      setToastReward(reward);
    };
    sseBus.addEventListener('reward-earned', handleRewardEarned);
    return () => sseBus.removeEventListener('reward-earned', handleRewardEarned);
  }, [customerId]);

  // TC-4: switching customers must never leave the previous customer's toast/status message
  // lingering on screen for the newly-selected one.
  useEffect(() => {
    setToastReward(null);
    setStatus(null);
  }, [customerId]);

  useEffect(() => {
    if (!toastReward) return undefined;
    const timer = setTimeout(() => setToastReward(null), TOAST_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toastReward]);

  function handleSubmit(values: ActivitySubmitValues) {
    if (!customerId || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setStatus(null);
    postActivity.mutate(
      { customerId, ...values },
      {
        onSuccess: (result) => {
          setStatus({ matched: result.matched, rewardCount: result.rewards.length });
        },
        onSettled: () => {
          submitInFlightRef.current = false;
        },
      },
    );
  }

  const campaignNameByCode = new Map(
    (campaignsQuery.data ?? []).map((campaign) => [campaign.campaignCode, campaign.name]),
  );

  if (customerLoading) {
    return (
      <Card className="p-6" aria-busy="true">
        <p className="font-body text-sm text-ink-muted">Loading…</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-ink sm:text-[28px]">
          Activity Simulator
        </h1>
        <p className="font-body text-sm text-ink-muted">
          Fire a real activity and watch it flow into tracker progress — and rewards — live.
        </p>
      </div>

      {status && (
        <p aria-live="polite" className="font-body text-sm text-ink-muted">
          {statusMessage(status)}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_3fr]">
        <ActivityForm
          activityTypeOptions={activityTypeOptions}
          optionsLoading={optionsLoading}
          isSubmitting={postActivity.isPending}
          onSubmit={handleSubmit}
        />
        <ActivityFeed query={activitiesQuery} />
      </div>

      {toastReward && (
        <RewardToast
          reward={toastReward}
          campaignName={
            campaignNameByCode.get(toastReward.campaignCode) ?? toastReward.campaignCode
          }
          onClose={() => setToastReward(null)}
        />
      )}
    </div>
  );
}
