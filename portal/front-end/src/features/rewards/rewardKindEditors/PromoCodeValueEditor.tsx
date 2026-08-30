/**
 * T-127 — the `PROMO_CODE` entry in `RewardValueEditor.tsx`'s `KIND_EDITORS` map.
 *
 * **This editor has no amount field, and that is the feature.** A promo code's value is not
 * decided when the reward is authored; it is decided at redemption, by the Promo Code Service
 * (`13-REWARD-MASTER-VALUE-SOURCES.md` §5 — *"a reward whose value isn't decided until
 * redemption"*). So the whole `value_config` is two things: which config service issues the code,
 * and where the reward may be attached.
 *
 * The provider is shown read-only rather than as a dropdown containing one option:
 * `PROMO_CODE_API_PROVIDERS` has exactly one member (T-119), and a picker with a single choice
 * asks a question whose answer is already decided. Its `planned` status is stated plainly here —
 * the honest "not available yet" state is this task's deliverable, not something to paper over
 * (task implementation note 4).
 *
 * Its own file rather than a fourth function inside `RewardValueEditor.tsx` because that is what
 * this task's `Files owned` names; the map there is unchanged apart from the one added entry.
 */
import type { PromoCodeBindLevel } from '@reward-portal/shared';
import { MultiSelect } from '../../../components/MultiSelect';
import { PROMO_CODE_API_PROVIDER, type KindEditorProps } from '../rewardValue';

interface BindLevelOption {
  readonly value: PromoCodeBindLevel;
  readonly label: string;
}

/** Human labels for the three attachment points, in the vocabulary's own order — the same three
 * slots step 5's reward tree renders (04-FRONTEND.md §5.5). */
const BIND_LEVEL_OPTIONS: readonly BindLevelOption[] = [
  { value: 'component', label: 'Component — paid when one journey step completes' },
  { value: 'tracker', label: 'Tracker — paid when a tracker completes' },
  { value: 'campaign', label: 'Campaign — paid once for the whole campaign' },
];

export function PromoCodeValueEditor({ draft, onChange }: KindEditorProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-control bg-slate-50 px-3 py-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Promo code config service
        </p>
        <p className="font-mono text-sm text-slate-700">{PROMO_CODE_API_PROVIDER}</p>
        <p className="mt-1 text-sm text-slate-500">
          This reward carries no amount. The code, and what it is worth, are issued at redemption
          time by the promo code service. That service is not available yet, so the maker attaching
          this reward will not be able to pick a specific config until it is.
        </p>
      </div>

      <MultiSelect
        label="Where can this be attached?"
        options={[...BIND_LEVEL_OPTIONS]}
        value={[...draft.promoCodeBindLevels]}
        placeholder="Pick at least one level…"
        onChange={(next) => {
          onChange({
            ...draft,
            // Re-derived from the fixed vocabulary rather than trusted as returned: this is the
            // value that becomes `value_config.bindLevels`, and `buildValueConfig` would reject
            // anything outside the enum anyway — better to never build it.
            promoCodeBindLevels: BIND_LEVEL_OPTIONS.filter((option) =>
              next.includes(option.value),
            ).map((option) => option.value),
          });
        }}
      />
    </div>
  );
}
