/**
 * T-RR-063. Computes the absolute UTC `expires_at` instant for a just-redeemed reward from its
 * `BoundReward`-derived duration (`expiry_value`/`expiry_unit`, T-173) and the exact instant the
 * redemption happened — a pure function, deliberately taking `nowUtc` as an explicit parameter
 * rather than reading the system clock itself, so it is unit-testable with no DB/clock mock
 * beyond the `Date` the caller already has in hand
 * (`RedemptionProcessingOrchestrator.processClaimedEntry`, this task's own implementation note 4).
 *
 * `expiryValue`/`expiryUnit` describe a *duration relative to being given*, not an absolute date —
 * this is the one place in the pipeline that knows the true redemption instant, so this
 * computation must happen here, from that same instant, or a separate later read-then-compute step
 * could race against a slow transaction and silently anchor the expiry to the wrong instant (this
 * file's own task header, "Why this must be computed here").
 *
 * **Shared-instant confirmation (task DoD; addressed after review retry 1).** The `nowUtc` passed
 * in here (a plain JS `Date`, computed via `new Date()` at the call site) must represent the same
 * real-world instant as the sibling `redeemed_at = now()` SQL assignment written in the same
 * `RedemptionStateMachineService` statement (`markDispatchedExternal`/`markCompletedDirect`) — the
 * task file requires this to be *confirmed*, not assumed, and escalated per `AGENT-PROTOCOL.md` §7
 * if it does not hold. It was confirmed, and it does *not* hold for the reason the task file
 * anticipated ("this service's own Postgres connection session timezone is UTC") — this project's
 * real local Postgres session (`rr_app`, `SHOW timezone`) is genuinely `Asia/Kuala_Lumpur`, not
 * UTC. It holds anyway, for an independent reason: Postgres `timestamptz` is always stored and
 * transmitted as an absolute instant — the session `TimeZone` GUC only controls the *display
 * offset* used when formatting that instant to/from text, never the value itself — and `node-pg`'s
 * wire-protocol parser converts that offset-qualified text back into a timezone-agnostic JS `Date`
 * (an epoch-ms instant). So `now()` read back through this service's own pool agrees with
 * `Date.now()`/`new Date()` regardless of the session's display timezone; no timezone conversion
 * happens anywhere in this codebase for `expires_at`, so there is nothing here that could be
 * "quietly converting" incorrectly. This is not a general license to ignore a non-UTC session
 * elsewhere — the same test (`test/redemption/redemption-state-machine.expiry.spec.ts`, "DB
 * session timezone / shared-instant confirmation") re-runs this exact confirmation against the
 * real database on every test run and would fail if the underlying assumption ever stopped
 * holding, at which point *that* would be the stop-and-escalate finding.
 */

const MS_PER_EXPIRY_UNIT: Record<'minutes' | 'hours' | 'days', number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/**
 * `null`/`null` (T-173's own proto sentinel, mapped from `0`/`''` by
 * `RewardSystemResolutionService.resolve()`) means the reward never expires — returns `null`.
 * Otherwise computes `nowUtc + expiryValue * <ms for expiryUnit>` using pure UTC millisecond
 * arithmetic (`Date#getTime()`/`new Date(ms)`), never local-calendar-day arithmetic — the only way
 * to stay correct across a DST-observing local timezone for a unit like `'days'` (TC-2).
 *
 * Throws — never silently guesses or defaults — for an `expiryUnit` outside the three known
 * values. `T-173`'s own `ck_rewv_expiry_unit` check constraint should make this unreachable via a
 * freshly-read config, but a stale cached value (this service's own `CampaignConfigCache`, T-RR-022)
 * could in principle still carry an enum value newer than this deployed build recognizes, and
 * guessing at an unknown duration unit is worse than failing loudly.
 */
export function computeExpiresAt(
  nowUtc: Date,
  expiryValue: number | null,
  expiryUnit: 'minutes' | 'hours' | 'days' | null,
): Date | null {
  if (expiryValue === null || expiryUnit === null) {
    return null;
  }

  const msPerUnit = MS_PER_EXPIRY_UNIT[expiryUnit];
  if (msPerUnit === undefined) {
    throw new Error(
      `computeExpiresAt: unknown expiryUnit "${String(expiryUnit)}" — expected one of ` +
        `'minutes' | 'hours' | 'days'.`,
    );
  }

  return new Date(nowUtc.getTime() + expiryValue * msPerUnit);
}
