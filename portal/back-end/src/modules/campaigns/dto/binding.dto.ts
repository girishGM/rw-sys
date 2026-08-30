/**
 * T-037 steps 4 and 5 — binding a rule to a component with its dynamic values, and attaching a
 * reward at one of the three levels.
 *
 * ### `values` is `object`-typed here, and that is the correct amount of validation for a DTO
 *
 * The real shape of `values` is not knowable until the rule's own `parameters` meta-schema has
 * been loaded from the database, so no decorator on this class can check it. What the service
 * does instead is the actual control: it loads the pinned version's `parameters`, builds the
 * value schema from it with the **shared** `buildRuleValueSchema` — the same function
 * `DynamicParameterForm` builds its form resolver from — and parses. Implementation note 9:
 * *"Re-validate on the server against the same version's schema — client-built validation is
 * trivially bypassed"* (TC-17, TC-18, TC-19, Verification step 6).
 *
 * `@IsObject()` is still worth having: it turns `values: "5"` into a 400 with a field-level
 * detail rather than a confusing schema error about every key at once.
 */
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  attachRewardRequestSchema,
  bindComponentRuleRequestSchema,
  REWARD_LEVELS,
  updateComponentRuleValuesRequestSchema,
} from '@reward-portal/shared';
import { MatchesSharedContract } from './shared-contract.decorator';

/**
 * `POST /campaigns/:id/rules` (03-API-CONTRACT.md §11) — *"bind a country-assigned rule + supply
 * dynamic values"*.
 *
 * `componentId` and not `trackerId`: **rules bind to a tracker component, never to the
 * campaign** (04-FRONTEND.md §5.1, implementation note 7). A rule answers *is this component
 * complete?*; completion rolls up through the tracker's logic.
 */
export class BindComponentRuleDto {
  @IsInt()
  @IsPositive()
  @MatchesSharedContract(bindComponentRuleRequestSchema)
  componentId!: number;

  /**
   * Restricted to rules assigned to the actor's country (implementation note 7). A rule id
   * outside that set is a **400**, *"never a silent skip that yields a campaign missing a rule
   * the maker believed they added"* (TC-15, Verification step 5) — see
   * `campaigns.errors.ts#RuleNotAssignedToCountryError` for why 400 and not the usual 404.
   */
  @IsInt()
  @IsPositive()
  ruleId!: number;

  /** See this file's header for where these are really validated. */
  @IsOptional()
  @IsObject()
  values?: Record<string, unknown>;
}

/**
 * `PATCH /campaigns/:id/rules/:bindingId` — step 4 edits values without re-picking the rule.
 *
 * T-147 — `operator` joins `values` here (this file's header explains the shape; the schema's
 * own header explains why one endpoint rather than two). Which operators are actually *allowed*
 * is runtime state (`BindingsService#updateRuleValues` checks it against the binding's pinned
 * version) — this decorator only checks that a supplied value is a plausible operator code.
 */
export class UpdateComponentRuleValuesDto {
  @IsObject()
  @MatchesSharedContract(updateComponentRuleValuesRequestSchema)
  values!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  operator?: string | null;
}

/**
 * `POST /campaigns/:id/rewards` — step 5.
 *
 * All three levels may be populated at once (implementation note 10, TC-21n); the step-5 tree
 * shows every attachment point including the empty ones, *"because a maker who cannot see that a
 * component has no reward will not notice they meant to add one"* (04-FRONTEND.md §5.5).
 *
 * `rewardPolicyId`, not `rewardId`: the three `reward_*_assignments` tables all key on
 * `reward_policy_id`. A reward *system* is the connector; a *policy* is the concrete thing that
 * pays.
 */
export class AttachRewardDto {
  @IsIn([...REWARD_LEVELS])
  @MatchesSharedContract(attachRewardRequestSchema)
  level!: 'campaign' | 'tracker' | 'component';

  /** The tracker or component id. Forbidden at campaign level — the same shape `ck_cc_ref`
   * enforces for caps, checked here by the shared contract. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  refId?: number;

  @IsInt()
  @IsPositive()
  rewardPolicyId!: number;

  /**
   * T-127 — the Promo Code Config the maker picked (`13-REWARD-MASTER-VALUE-SOURCES.md` §5).
   *
   * Optional, and absent on almost every attach today: `PROMO_CODE_CONFIG_SERVICE` is seeded
   * `planned`, so the picker has nothing to offer and the maker attaches without one. Whether it
   * is *allowed* at all depends on the reward's live version — a question no decorator can answer,
   * so `BindingsService` answers it (`PromoCodeConfigNotApplicableError`), the same division of
   * labour this file's header describes for `values`.
   */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  promoCodeConfig?: string;
}
