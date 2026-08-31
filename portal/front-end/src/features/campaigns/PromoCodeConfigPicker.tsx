/**
 * T-127 — the live Promo Code Config dropdown the maker sees in step 5 when the reward they are
 * attaching has `reward_kind: PROMO_CODE` (`13-REWARD-MASTER-VALUE-SOURCES.md` §5).
 *
 * ### The "not available yet" state is the deliverable, not a failure
 *
 * `PROMO_CODE_CONFIG_SERVICE` is seeded `planned` (T-121), and T-123 answers a `planned` provider
 * with **501 `FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE`** — deliberately, with no network call
 * attempted. So today this component's normal, correct render is an explanatory line and a
 * disabled control, and the attachment still succeeds without a pick (task implementation note 4:
 * *"Do not stub a fake working response to make the dropdown 'feel' complete"*).
 *
 * A 501 is therefore **not** rendered as an error: it is the documented answer to a question that
 * has not been built yet. Anything else that goes wrong (502/504 from a provider that has been
 * switched on, a contract mismatch, an offline browser) *is* shown as a failure, using the
 * server's own message — 04-FRONTEND.md §8 note 5: the SPA never invents its own copy for a
 * server-side failure.
 *
 * ### Why this lives in `features/campaigns/`
 *
 * It is part of the maker's attach flow, which is this feature's. T-125 builds the Super Admin's
 * general-purpose value-source picker for *rule parameter fields* — a different screen, a
 * different provider set and a different write target; when that lands, whether these two
 * collapse into one shared control is a judgement for whoever owns the merge, not something to
 * pre-empt by reaching into another task's in-flight files.
 */
import { PROMO_CODE_API_PROVIDER } from '../rewards/rewardValue';
import { Select } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { useApiLookupOptionsQuery } from './api';

/** T-123's 501 code for a `planned` (or `inactive`) provider. */
const PROVIDER_NOT_AVAILABLE = 'FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE';

export interface PromoCodeConfigPickerProps {
  /** The picked config, or `null` for "nothing picked" — which is every attachment today. */
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly disabled?: boolean;
}

export function PromoCodeConfigPicker({ value, onChange, disabled }: PromoCodeConfigPickerProps) {
  const query = useApiLookupOptionsQuery(PROMO_CODE_API_PROVIDER);

  const error = query.error;
  const notAvailable =
    error instanceof ApiError && (error.code === PROVIDER_NOT_AVAILABLE || error.status === 501);

  return (
    <div className="grid gap-1" data-testid="promo-code-config-picker">
      <Select
        label="Promo code config"
        options={(query.data ?? []).map((option) => ({
          value: String(option.value),
          label: option.label,
        }))}
        value={value}
        disabled={disabled === true || query.isLoading || error !== null}
        placeholder={
          query.isLoading
            ? 'Loading…'
            : notAvailable
              ? 'Nothing to pick yet'
              : error !== null
                ? 'Could not load'
                : 'Select a promo code config…'
        }
        onChange={(next) => {
          onChange(next === '' ? null : next);
        }}
      />

      {notAvailable ? (
        <p className="text-sm text-slate-500">
          This reward&rsquo;s code is issued at redemption time. The promo code service is not
          available yet, so there is nothing to pick — you can still attach the reward now and set
          its config once that service is live.
        </p>
      ) : error !== null ? (
        <p role="alert" className="text-sm text-danger-600">
          {error instanceof ApiError ? error.message : 'Could not load promo code configs.'}
        </p>
      ) : (
        <p className="text-sm text-slate-500">
          This reward pays no fixed amount — the code, and what it is worth, are decided at
          redemption.
        </p>
      )}
    </div>
  );
}
