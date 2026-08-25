/**
 * T-037 — the seven-step campaign wizard (04-FRONTEND.md §5.2).
 *
 * ```
 * 1 Basics    2 Merchants   3 Journey   4 Component rules
 * 5 Rewards   6 Budgets & limits        7 Review
 * ```
 *
 * ### Draft persistence is the server's, not the browser's
 *
 * Implementation note 12: *"draft saved after every step; the journey tree is saved incrementally
 * so a lost tab never costs a built structure."* Every step here writes through to the API as the
 * maker works — there is no accumulated client-side draft to lose, and **nothing is kept in
 * `localStorage`** (which would also be the wrong place for anything session-shaped, R5).
 *
 * That is why the wizard's URL changes: `/campaigns/new` has nothing to save against, so step 1
 * creates the campaign and the route becomes `/campaigns/:id`. Reloading at step 3 then restores
 * the built structure from the server (Verification step 7), because the server is where it lives.
 *
 * ### Step gating
 *
 * Steps after 1 are unreachable until the campaign exists — there is literally nothing to attach
 * them to. Beyond that the wizard does **not** block navigation on incomplete steps: a maker may
 * jump to step 6, and step 7 tells them everything that is still missing at once
 * (`validateStructure`). Blocking each step would force a strict order the design does not ask
 * for and would make fixing one problem a walk back through five screens.
 *
 * ### The current step lives on the history entry, not in component state (T-076)
 *
 * It used to be a plain `useState(0)`, and that quietly broke the one navigation this wizard
 * cannot avoid. `/campaigns/new` renders this component directly; `/campaigns/:id` renders
 * `CampaignDetailPage`, which renders this component for an editable draft. Those are two
 * different element trees, so the `navigate()` in `saveBasics` **unmounts** the wizard and mounts
 * a fresh one — and the `setStep(1)` that followed it had no live component left to apply to.
 * Every maker who created a draft was dropped back onto Basics, with no error to explain it.
 *
 * Moving the step into the router's own location state fixes that at the cause rather than
 * papering over the remount: the step is a property of *where the maker is*, so it belongs to the
 * location, and it is carried by the same `navigate()` call that changes the URL — one atomic
 * transition, with no second call that a remount can land in the middle of. It is restored with
 * the history entry the same way the URL is, including across a reload, since the browser
 * persists `history.state` per entry. There is no local step state left to lose, which is what
 * makes the defect unrepeatable rather than merely fixed.
 *
 * It is deliberately **not** a query string: `?step=` would be a new public contract on a URL
 * other code already matches on (`/campaigns/\d+$`), for no gain a maker can see. It is equally
 * deliberately not a merge of the two routes into one — `/campaigns/:id` legitimately renders a
 * *different screen* (`CampaignDetailPage`'s read-only tabs) once the campaign is no longer
 * editable, so the remount is correct behaviour and only the lost step was the bug.
 *
 * Every step change `replace`s the current entry rather than pushing a new one, so "Back" still
 * means "leave the wizard" and not "undo one step, seven times".
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, type Location } from 'react-router-dom';
import type { CampaignCapInput, RewardLevel } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { Stepper } from '../../components/Stepper';
import { ApiError } from '../../lib/apiError';
import { CampaignStatusPill } from './CampaignStatusPill';
import {
  useActivityOptionsQuery,
  useAttachRewardMutation,
  useBindRuleMutation,
  useCampaignMerchantsQuery,
  useCampaignQuery,
  useCapsQuery,
  useCreateCampaignMutation,
  useCreateComponentMutation,
  useCreateTrackerMutation,
  useDeleteComponentMutation,
  useDeleteTrackerMutation,
  useDetachRewardMutation,
  useJourneyQuery,
  usePutCapsMutation,
  useReorderComponentsMutation,
  useReviewQuery,
  useRewardOptionsQuery,
  useRuleOptionsQuery,
  useSetMerchantsMutation,
  useSubmitCampaignMutation,
  useUnbindRuleMutation,
  useUpdateCampaignMutation,
  useUpdateComponentMutation,
  useUpdateRuleValuesMutation,
  useUpdateTrackerMutation,
} from './api';
import { BasicsStep } from './steps/BasicsStep';
import { basicsFrom, emptyBasics, toCreateRequest, type BasicsValues } from './steps/basicsValues';
import { MerchantsStep } from './steps/MerchantsStep';
import { JourneyStep } from './steps/JourneyStep';
import { ComponentRulesStep } from './steps/ComponentRulesStep';
import { RewardsStep } from './steps/RewardsStep';
import { BudgetsStep } from './steps/BudgetsStep';
import { ReviewStep } from './steps/ReviewStep';

const STEPS = [
  { label: 'Basics', description: 'Name, code, dates' },
  { label: 'Merchants', description: 'Who takes part' },
  { label: 'Journey', description: 'Trackers and steps' },
  { label: 'Rules', description: 'Dynamic values' },
  { label: 'Rewards', description: 'Three levels' },
  { label: 'Budgets', description: 'Budgets and limits' },
  { label: 'Review', description: 'Submit for approval' },
];

const FIRST_STEP = 0;
const LAST_STEP = STEPS.length - 1;

/**
 * The key this wizard keeps its step under inside the history entry's `state`. Namespaced rather
 * than a bare `step` because location state is shared with whatever else navigates here.
 */
const STEP_STATE_KEY = 'wizardStep';

/**
 * The current step, read from the history entry rather than from component state (see this file's
 * header for why). Everything here is defensive on purpose: `history.state` survives reloads and
 * the Back button, can be hand-edited in devtools, and can outlive the code that wrote it, so it
 * is untrusted input in exactly the way a query string is.
 *
 * `location.state` is typed `any` by react-router, so it is read into an `unknown` first — nothing
 * downstream gets to skip a check because the type system looked away.
 */
function readStep(location: Location, campaignId: number | null): number {
  // Steps past Basics have nothing to attach to until the campaign exists (see "Step gating"),
  // so on `/campaigns/new` a recorded step is not merely ignored — it is meaningless.
  if (campaignId === null) return FIRST_STEP;

  const state: unknown = location.state;
  if (typeof state !== 'object' || state === null) return FIRST_STEP;

  const recorded: unknown = (state as Record<string, unknown>)[STEP_STATE_KEY];
  if (typeof recorded !== 'number' || !Number.isInteger(recorded)) return FIRST_STEP;

  // A stale entry written by an older build may name a step this one no longer has.
  return Math.min(LAST_STEP, Math.max(FIRST_STEP, recorded));
}

/**
 * The step written back onto a history entry's state, keeping whatever else that entry carries —
 * this wizard does not own `location.state`, it only owns one key inside it.
 */
function withStep(existing: unknown, next: number): Record<string, unknown> {
  const base = typeof existing === 'object' && existing !== null ? existing : {};
  return {
    ...(base as Record<string, unknown>),
    [STEP_STATE_KEY]: Math.min(LAST_STEP, Math.max(FIRST_STEP, next)),
  };
}

export function CampaignWizardPage() {
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const campaignId = params.id === undefined ? null : Number(params.id);
  const step = readStep(location, campaignId);
  const [basics, setBasics] = useState<BasicsValues>(emptyBasics);
  const [error, setError] = useState<string | undefined>(undefined);

  const campaignQuery = useCampaignQuery(campaignId);
  const journeyQuery = useJourneyQuery(campaignId);
  const merchantsQuery = useCampaignMerchantsQuery(campaignId);
  const activitiesQuery = useActivityOptionsQuery(campaignId);
  const ruleOptionsQuery = useRuleOptionsQuery(campaignId);
  const rewardOptionsQuery = useRewardOptionsQuery(campaignId);
  const capsQuery = useCapsQuery(campaignId);
  const reviewQuery = useReviewQuery(campaignId, step === 6);

  const campaign = campaignQuery.data ?? null;
  const readOnly = campaign !== null && !campaign.editable;

  // Seed the basics form from the server once the campaign is known.
  //
  // The dependency is the **`updatedAt` string**, not the campaign object: TanStack Query hands
  // back a new object reference on every refetch, so depending on `campaign` would reset the form
  // under the maker's cursor each time any query on this screen settled. Keying on the server's
  // own version marker re-seeds exactly when the campaign really changed. `campaign` itself is
  // read inside the effect, which is why the rule is silenced on the dependency array below
  // rather than satisfied — adding it to the array is precisely the bug this comment describes.
  //
  // The disable directive must sit on the line *immediately* before `}, [campaignVersion]);`:
  // `eslint-disable-next-line` targets the literal next line, so any comment line in between
  // absorbs it and the real violation goes unsuppressed.
  const campaignVersion = campaign === null ? null : `${String(campaign.id)}@${campaign.updatedAt}`;
  useEffect(() => {
    if (campaign !== null) setBasics(basicsFrom(campaign));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- T-037: intentional, see above.
  }, [campaignVersion]);

  const createCampaign = useCreateCampaignMutation();
  const updateCampaign = useUpdateCampaignMutation(campaignId ?? 0);
  const setMerchants = useSetMerchantsMutation(campaignId ?? 0);
  const createTracker = useCreateTrackerMutation(campaignId ?? 0);
  const updateTracker = useUpdateTrackerMutation(campaignId ?? 0);
  const deleteTracker = useDeleteTrackerMutation(campaignId ?? 0);
  const createComponent = useCreateComponentMutation(campaignId ?? 0);
  const updateComponent = useUpdateComponentMutation(campaignId ?? 0);
  const deleteComponent = useDeleteComponentMutation(campaignId ?? 0);
  const reorder = useReorderComponentsMutation(campaignId ?? 0);
  const bindRule = useBindRuleMutation(campaignId ?? 0);
  const updateRuleValues = useUpdateRuleValuesMutation(campaignId ?? 0);
  const unbindRule = useUnbindRuleMutation(campaignId ?? 0);
  const attachReward = useAttachRewardMutation(campaignId ?? 0);
  const detachReward = useDetachRewardMutation(campaignId ?? 0);
  const putCaps = usePutCapsMutation(campaignId ?? 0);
  const submit = useSubmitCampaignMutation(campaignId ?? 0);

  /** One place that turns an `ApiError` into a sentence, so no step invents its own. */
  function report(cause: unknown): void {
    setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.');
  }

  function run<T>(promise: Promise<T>): void {
    setError(undefined);
    promise.catch(report);
  }

  /**
   * Move to another step of the campaign already open. The URL does not change — only the step
   * recorded on the current history entry does — and the entry is `replace`d, so the browser's
   * Back button still leaves the wizard rather than walking back through six steps.
   *
   * `location.pathname` is passed absolutely rather than as `'.'`: a relative target resolves
   * against the matched route, which is `/campaigns/:id` here and `/campaigns/new` one render
   * earlier, and that difference is exactly the class of bug this task exists to fix.
   */
  function goToStep(next: number): void {
    setError(undefined);
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: withStep(location.state, next),
    });
  }

  const journey = journeyQuery.data;

  const serverFieldErrors = useMemo(() => {
    // `details` from a 400 on a rule binding are `{ field: 'values.minSpend' }` — mapped onto the
    // generated form control so TC-17's failure lands on the field that caused it.
    return {};
  }, []);

  function saveBasics(): void {
    if (campaignId === null) {
      run(
        createCampaign.mutateAsync(toCreateRequest(basics)).then((created) => {
          // One navigation carries both the new URL and the step it opens on. Two calls — the
          // `navigate()` plus a `setStep(1)` after it — is what used to drop the maker back onto
          // Basics: this component is unmounted by the first before the second can reach it.
          navigate(`/campaigns/${String(created.id)}`, {
            replace: true,
            state: withStep(location.state, 1),
          });
        }),
      );
      return;
    }

    run(
      updateCampaign.mutateAsync({
        name: basics.name.trim(),
        description: basics.description.trim() === '' ? null : basics.description.trim(),
        // Calendar dates, sent exactly as the date input holds them — see `campaignDate.ts` and
        // T-065 for what converting them here used to cost.
        startDate: basics.startDate,
        endDate: basics.endDate,
        maxParticipants: basics.maxParticipants === '' ? null : Number(basics.maxParticipants),
        budgetAmount: basics.budgetAmount === '' ? null : basics.budgetAmount,
        budgetCurrency: basics.budgetCurrency === '' ? null : basics.budgetCurrency,
      }),
    );
  }

  function moveComponent(trackerId: number, componentId: number, direction: -1 | 1): void {
    const tracker = journey?.trackers.find((entry) => entry.id === trackerId);
    if (tracker === undefined) return;
    const ordered = [...tracker.components];
    const index = ordered.findIndex((entry) => entry.id === componentId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];

    run(
      reorder.mutateAsync({
        trackerId,
        input: {
          order: ordered.map((component, position) => ({
            componentId: component.id,
            sequenceOrder: position + 1,
          })),
        },
      }),
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        title={campaign === null ? 'New campaign' : campaign.name}
        description="Build the customer journey, bind the rules that decide it, and set what it may spend."
        actions={campaign !== null && <CampaignStatusPill status={campaign.effectiveStatus} />}
      />

      <Stepper steps={STEPS} currentStep={step} className="mb-6" />

      {readOnly && (
        <p role="status" className="mb-4 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
          This campaign is {campaign.effectiveStatus.replace('_', ' ')} and can no longer be edited.
        </p>
      )}

      {campaign?.lastReviewComment !== null && campaign?.lastReviewComment !== undefined && (
        <p role="status" className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Sent back by a checker: {campaign.lastReviewComment}
        </p>
      )}

      <div className="grid gap-5">
        {step === 0 && (
          <BasicsStep
            values={basics}
            onChange={setBasics}
            onSave={saveBasics}
            saving={createCampaign.isPending || updateCampaign.isPending}
            campaign={campaign}
            serverError={error}
          />
        )}

        {step === 1 && campaignId !== null && (
          <MerchantsStep
            selected={merchantsQuery.data ?? []}
            disabled={readOnly}
            onChange={(merchantIds) => {
              run(setMerchants.mutateAsync({ merchantIds }));
            }}
          />
        )}

        {step === 2 && campaignId !== null && (
          <JourneyStep
            journey={journey}
            activities={activitiesQuery.data ?? []}
            disabled={readOnly}
            error={error}
            onAddTracker={(name) => {
              run(createTracker.mutateAsync({ name, completionLogic: 'all' }));
            }}
            onUpdateTracker={(trackerId, input) => {
              run(updateTracker.mutateAsync({ trackerId, input }));
            }}
            onDeleteTracker={(trackerId) => {
              run(deleteTracker.mutateAsync(trackerId));
            }}
            onAddComponent={(trackerId, name, activityId) => {
              run(createComponent.mutateAsync({ trackerId, input: { name, activityId } }));
            }}
            onUpdateComponent={(componentId, input) => {
              run(updateComponent.mutateAsync({ componentId, input }));
            }}
            onDeleteComponent={(componentId) => {
              run(deleteComponent.mutateAsync(componentId));
            }}
            onMoveComponent={moveComponent}
          />
        )}

        {step === 3 && campaignId !== null && (
          <ComponentRulesStep
            journey={journey}
            ruleOptions={ruleOptionsQuery.data ?? []}
            disabled={readOnly}
            serverErrors={serverFieldErrors}
            onBindRule={(componentId, ruleId) => {
              run(bindRule.mutateAsync({ componentId, ruleId }));
            }}
            onUnbindRule={(bindingId) => {
              run(unbindRule.mutateAsync(bindingId));
            }}
            onSaveValues={(bindingId, values) => {
              run(updateRuleValues.mutateAsync({ bindingId, input: { values } }));
            }}
          />
        )}

        {step === 4 && campaignId !== null && (
          <RewardsStep
            journey={journey}
            rewardOptions={rewardOptionsQuery.data ?? []}
            worstCasePayout={capsQuery.data?.worstCasePayout ?? []}
            disabled={readOnly}
            onAttach={(level: RewardLevel, refId, rewardPolicyId) => {
              run(
                attachReward.mutateAsync(
                  refId === null ? { level, rewardPolicyId } : { level, refId, rewardPolicyId },
                ),
              );
            }}
            onDetach={(level, assignmentId) => {
              run(detachReward.mutateAsync({ level, assignmentId }));
            }}
          />
        )}

        {step === 5 && campaignId !== null && (
          <BudgetsStep
            caps={capsQuery.data?.caps ?? []}
            warnings={capsQuery.data?.warnings ?? []}
            ceilings={capsQuery.data?.ceilings ?? []}
            journey={journey}
            campaignCurrency={campaign?.budgetCurrency ?? null}
            disabled={readOnly}
            saving={putCaps.isPending}
            serverError={error}
            onSave={(caps: CampaignCapInput[], confirmCurrencyMismatch) => {
              run(putCaps.mutateAsync({ caps, confirmCurrencyMismatch }));
            }}
          />
        )}

        {step === 6 && campaignId !== null && (
          <ReviewStep
            review={reviewQuery.data}
            submitting={submit.isPending}
            submitError={error}
            onSubmit={() => {
              run(
                submit.mutateAsync().then(() => {
                  // Submitting ends the wizard: the campaign is no longer editable, so this lands
                  // on `CampaignDetailPage`'s read-only tabs. The step travels with the
                  // navigation for the same reason it does in `saveBasics` — and it still matters
                  // if a checker sends the campaign back, which makes it a draft again.
                  navigate(`/campaigns/${String(campaignId)}`, {
                    state: withStep(location.state, LAST_STEP),
                  });
                }),
              );
            }}
          />
        )}

        <div className="flex items-center justify-between border-t border-slate-200 pt-4">
          <Button
            type="button"
            variant="secondary"
            disabled={step === FIRST_STEP}
            onClick={() => {
              goToStep(step - 1);
            }}
          >
            Back
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={step === LAST_STEP || campaignId === null}
            onClick={() => {
              goToStep(step + 1);
            }}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
