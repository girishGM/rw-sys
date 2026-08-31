/**
 * T-120 — the non-component half of the Reward Master category/Kind/value editor: the queries the
 * pickers read from, the `kind → editor` registry's data, and the one function that turns the
 * form's raw text state into a `value_config` the server will accept.
 *
 * Split out of `RewardValueEditor.tsx` for the same reason `auth/useBootstrap.ts` is split from
 * `auth/BootstrapProvider.tsx`: the workspace lint gate runs at `--max-warnings=0` and
 * `react-refresh/only-export-components` flags a component file that also exports hooks and
 * constants. Everything here is a hook, a constant or a pure function; the components live next
 * door.
 *
 * ### Where the Kind actually lives
 *
 * Not on `reward_systems` — 13-REWARD-MASTER-VALUE-SOURCES.md §5 puts `reward_kind`/`value_config`
 * on `reward_versions`, so authoring a Kind is authoring a **draft version** of the reward
 * (`POST /rewards/:id/versions`, which `reward.schema.ts#createRewardVersionRequestSchema`
 * documents as "how the Reward Master screen (T-120) authors one in a single step"). That is why
 * this file carries its own `createRewardVersionDraft` rather than reusing
 * `features/versions/api.ts#createDraft`: the shared `createVersionRequestSchema` that call parses
 * with is `.strict()` and rule-shaped — it has no `rewardKind`/`valueConfig` keys and would strip
 * or reject them. Updating an *existing* draft needs no such helper: `updateDraft` there already
 * parses reward drafts with `updateRewardVersionRequestSchema`, which does carry the pair.
 *
 * ### Validation
 *
 * `buildValueConfig` never re-states the per-kind shapes. It assembles a candidate object and
 * hands it to `rewardVersionValueSchema` — the same discriminated union the back end validates
 * with (00-ARCHITECTURE.md §8) — so a value this editor accepts is by construction one the server
 * accepts, and adding a kind is a schema change, not a second copy of the rules here.
 */
import { useQuery } from '@tanstack/react-query';
import {
  PROMO_CODE_API_PROVIDERS,
  PROMO_CODE_BIND_LEVELS,
  createRewardVersionRequestSchema,
  rewardCategoryListEnvelopeSchema,
  rewardSubCategoryListEnvelopeSchema,
  rewardVersionEnvelopeSchema,
  rewardVersionValueSchema,
  tenantCurrencyListEnvelopeSchema,
  type CreateRewardVersionRequest,
  type PromoCodeBindLevel,
  type RewardCategory,
  type RewardKind,
  type RewardSubCategory,
  type RewardVersion,
  type TenantCurrency,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

// --- the Kind registry -------------------------------------------------------------------------

/**
 * The Kinds this screen can author today.
 *
 * T-127 added `PROMO_CODE` — exactly the one-line registration T-120 designed this array (and
 * `RewardValueEditor.tsx`'s `KIND_EDITORS` map) for. It is the one Kind whose value config names a
 * `field_api_lookup_providers` entry (`PROMO_CODE_CONFIG_SERVICE`, T-121) instead of an amount:
 * its value is not decided until redemption (`13-REWARD-MASTER-VALUE-SOURCES.md` §5).
 */
export const SUPPORTED_REWARD_KINDS = [
  'FIXED_AMOUNT',
  'PERCENTAGE',
  'POINTS',
  'PHYSICAL',
  'PROMO_CODE',
] as const satisfies readonly RewardKind[];

export type SupportedRewardKind = (typeof SUPPORTED_REWARD_KINDS)[number];

/**
 * Labels for **every** kind the database can hold, not just the authorable ones: a reward whose
 * version was authored elsewhere (or by T-127, once `PROMO_CODE` exists) still has to display as
 * something other than a raw enum on a detail screen.
 */
export const REWARD_KIND_LABELS: Record<RewardKind, string> = {
  FIXED_AMOUNT: 'Fixed amount',
  PERCENTAGE: 'Percentage',
  POINTS: 'Points',
  PHYSICAL: 'Physical',
  PROMO_CODE: 'Promo code',
};

export function isSupportedRewardKind(value: string): value is SupportedRewardKind {
  return (SUPPORTED_REWARD_KINDS as readonly string[]).includes(value);
}

// --- the editor's own draft state --------------------------------------------------------------

/**
 * Everything the value editor holds, for every kind, as **raw text**.
 *
 * One flat object rather than a per-kind union: switching Kind back and forth must not silently
 * discard what was already typed for the other one (a Maker who mis-clicks Percentage and clicks
 * back gets their amount back), and `buildValueConfig` only ever reads the keys that belong to the
 * kind actually selected, so a leftover value from another kind can never reach the wire.
 */
export interface RewardValueDraft {
  readonly kind: SupportedRewardKind | '';
  readonly multiCurrency: boolean;
  readonly defaultCurrency: string;
  readonly defaultValue: string;
  /** Currency code → the amount typed for it. Absent/blank entries are simply not sent. */
  readonly currencyValues: Readonly<Record<string, string>>;
  readonly percentage: string;
  readonly points: string;
  readonly sku: string;
  readonly description: string;
  /** T-127 — `PROMO_CODE` only: the levels this reward may be attached at. No amount field
   * accompanies it; §5 is explicit that this Kind "carries no amount at all". */
  readonly promoCodeBindLevels: readonly PromoCodeBindLevel[];
}

export const EMPTY_REWARD_VALUE_DRAFT: RewardValueDraft = {
  kind: '',
  multiCurrency: false,
  defaultCurrency: '',
  defaultValue: '',
  currencyValues: {},
  percentage: '',
  points: '',
  sku: '',
  description: '',
  promoCodeBindLevels: [],
};

/**
 * T-127 — what every kind editor in `RewardValueEditor.tsx`'s `KIND_EDITORS` map is handed.
 *
 * Declared here rather than beside the map for the same reason the rest of this file is split out
 * of that component: the workspace lints at `--max-warnings=0`, and once a second editor lives in
 * its own module the props type has to be importable from both without either component file
 * exporting a non-component.
 *
 * Uniform across kinds so the map can stay a plain `Record` — a kind that needs none of the
 * currency props simply ignores them.
 */
export interface KindEditorProps {
  readonly draft: RewardValueDraft;
  readonly onChange: (draft: RewardValueDraft) => void;
  readonly currencies: readonly TenantCurrency[];
  readonly currenciesLoading: boolean;
}

/**
 * T-127 — the single API lookup provider a `PROMO_CODE` reward's value config may name
 * (`PROMO_CODE_API_PROVIDERS`, T-119). Not a picker: there is exactly one, it is seeded `planned`,
 * and the authoring screen shows it read-only rather than offering a choice of one
 * (task implementation note 2).
 */
export const PROMO_CODE_API_PROVIDER = PROMO_CODE_API_PROVIDERS[0];

/** `''`/whitespace is "not filled in", never `0` — `Number('')` is `0`, which would silently
 * author a zero-value reward from an empty box. */
function toNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

export type BuildValueConfigResult =
  | { readonly state: 'unset' }
  | {
      readonly state: 'ok';
      readonly rewardKind: RewardKind;
      readonly valueConfig: Record<string, unknown>;
    }
  | { readonly state: 'invalid'; readonly message: string };

/**
 * Turns the draft into the `(rewardKind, valueConfig)` pair `POST /rewards/:id/versions` takes.
 *
 * `unset` — no Kind chosen at all, which is a legitimate state (`reward_versions` allows a
 * version with neither key; `isRewardVersionValue` accepts it). The caller simply sends nothing.
 */
export function buildValueConfig(draft: RewardValueDraft): BuildValueConfigResult {
  if (draft.kind === '') return { state: 'unset' };

  const candidate = valueConfigCandidate(draft.kind, draft);
  const parsed = rewardVersionValueSchema.safeParse({
    rewardKind: draft.kind,
    valueConfig: candidate,
  });
  if (!parsed.success) {
    return { state: 'invalid', message: firstIssueMessage(parsed.error.issues) };
  }
  return {
    state: 'ok',
    rewardKind: draft.kind,
    valueConfig: parsed.data.valueConfig as unknown as Record<string, unknown>,
  };
}

/** The shape for the selected kind, before validation — the only place a kind's key names are
 * written down on the client. */
function valueConfigCandidate(
  kind: SupportedRewardKind,
  draft: RewardValueDraft,
): Record<string, unknown> {
  switch (kind) {
    case 'FIXED_AMOUNT':
      return draft.multiCurrency
        ? {
            multiCurrency: true,
            currencyValues: Object.entries(draft.currencyValues)
              .filter(([, text]) => text.trim() !== '')
              .map(([currency, text]) => ({ currency, value: toNumber(text) })),
          }
        : {
            multiCurrency: false,
            defaultCurrency: draft.defaultCurrency,
            defaultValue: toNumber(draft.defaultValue),
          };
    case 'PERCENTAGE':
      return { percentage: toNumber(draft.percentage) };
    case 'POINTS':
      return { points: toNumber(draft.points) };
    case 'PHYSICAL':
      return { sku: draft.sku.trim(), description: draft.description.trim() };
    case 'PROMO_CODE':
      // No amount, no currency — §5. `bindLevels` is sent in the vocabulary's own order rather
      // than in click order, so two authors who tick the same boxes produce the same stored JSON.
      return {
        apiProvider: PROMO_CODE_API_PROVIDER,
        bindLevels: PROMO_CODE_BIND_LEVELS.filter((level) =>
          draft.promoCodeBindLevels.includes(level),
        ),
      };
  }
}

/** Zod reports every issue; the form shows one line, so pick the first and prefix the field it
 * belongs to when there is one. */
function firstIssueMessage(issues: readonly { message: string; path: PropertyKey[] }[]): string {
  const issue = issues[0];
  if (issue === undefined) return 'This value is not valid.';
  const field = issue.path.filter((part) => typeof part === 'string').join('.');
  return field === '' ? issue.message : `${field}: ${issue.message}`;
}

/** The reward's Kind/value as it is stored on a version, mapped back into editor state so Edit
 * opens on what is actually saved rather than on a blank form. */
export function draftFromVersion(version: {
  readonly rewardKind?: RewardKind | null;
  readonly valueConfig?: Record<string, unknown> | null;
}): RewardValueDraft {
  const kind = version.rewardKind ?? '';
  if (kind === '' || !isSupportedRewardKind(kind)) return EMPTY_REWARD_VALUE_DRAFT;

  const config = version.valueConfig ?? {};
  const text = (value: unknown): string =>
    typeof value === 'number' || typeof value === 'string' ? String(value) : '';

  const currencyValues: Record<string, string> = {};
  const rawCurrencyValues = config['currencyValues'];
  if (Array.isArray(rawCurrencyValues)) {
    for (const entry of rawCurrencyValues) {
      if (entry !== null && typeof entry === 'object' && 'currency' in entry) {
        const row = entry as { currency: unknown; value: unknown };
        if (typeof row.currency === 'string') currencyValues[row.currency] = text(row.value);
      }
    }
  }

  const rawBindLevels = config['bindLevels'];
  const promoCodeBindLevels = Array.isArray(rawBindLevels)
    ? PROMO_CODE_BIND_LEVELS.filter((level) => rawBindLevels.includes(level))
    : [];

  return {
    ...EMPTY_REWARD_VALUE_DRAFT,
    kind,
    multiCurrency: config['multiCurrency'] === true,
    defaultCurrency: text(config['defaultCurrency']),
    defaultValue: text(config['defaultValue']),
    currencyValues,
    percentage: text(config['percentage']),
    points: text(config['points']),
    sku: text(config['sku']),
    description: text(config['description']),
    promoCodeBindLevels,
  };
}

// --- reward categories -------------------------------------------------------------------------
//
// Read-only pickers, not a second category manager: authoring the category *list* is T-116/T-117's
// `CategoryManager`, and this screen only ever picks one of its rows (task file implementation
// note 1). The query keys deliberately match `features/shared/CategoryManager.tsx`'s own, so a
// category created there appears in this picker with no reload — one cache, one truth.

export function rewardCategoriesQueryKey(): readonly [string] {
  return ['reward-categories'];
}

export function rewardSubCategoriesQueryKey(categoryId?: number): readonly [string, number | null] {
  return ['reward-sub-categories', categoryId ?? null];
}

export async function fetchRewardCategories(): Promise<readonly RewardCategory[]> {
  try {
    const response = await api.get<unknown>('/reward-categories');
    const parsed = rewardCategoryListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Reward categories response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useRewardCategoriesQuery() {
  return useQuery({ queryKey: rewardCategoriesQueryKey(), queryFn: fetchRewardCategories });
}

export async function fetchRewardSubCategories(
  categoryId?: number,
): Promise<readonly RewardSubCategory[]> {
  try {
    const response = await api.get<unknown>('/reward-sub-categories', {
      params: categoryId === undefined ? {} : { categoryId },
    });
    const parsed = rewardSubCategoryListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Reward sub-categories response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

/** Disabled until a category is picked — a sub-category only means anything inside one, the same
 * cascade `AddRuleModal`/`RulesListPage` already use. */
export function useRewardSubCategoriesQuery(categoryId?: number) {
  return useQuery({
    queryKey: rewardSubCategoriesQueryKey(categoryId),
    queryFn: () => fetchRewardSubCategories(categoryId),
    enabled: categoryId !== undefined,
  });
}

// --- tenant currencies (T-126) -----------------------------------------------------------------

export function tenantCurrenciesQueryKey(tenantId: number): readonly [string, number, string] {
  return ['tenants', tenantId, 'currencies'] as const;
}

export async function fetchTenantCurrencies(tenantId: number): Promise<readonly TenantCurrency[]> {
  try {
    const response = await api.get<unknown>(`/tenants/${String(tenantId)}/currencies`);
    const parsed = tenantCurrencyListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Tenant currencies response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * The currencies the multi-currency editor offers — 13-REWARD-MASTER-VALUE-SOURCES.md §4: "reads
 * this list for the tenant/country context being edited, instead of a hardcoded currency array".
 *
 * `tenantId` comes from the caller's own scope (or, for a `super_admin` who has none, from the
 * tenant they pick as the currency context). It is a path parameter the server re-authorises
 * against the verified JWT — `TenantCurrenciesService.list` goes through `ScopedRepository`, so a
 * tenant-scoped caller asking for another tenant's list gets a 404, not that tenant's data
 * (AGENT-PROTOCOL R3: the client never *decides* scope, it only names a resource).
 *
 * Retired currencies are filtered out here rather than server-side: `GET /tenants/:id/currencies`
 * is also the management screen's own list and must keep showing `inactive` rows there.
 */
export function useTenantCurrenciesQuery(tenantId: number | null | undefined) {
  const id = tenantId ?? undefined;
  return useQuery({
    queryKey: tenantCurrenciesQueryKey(id ?? 0),
    queryFn: () => fetchTenantCurrencies(id as number),
    enabled: id !== undefined,
    select: (rows: readonly TenantCurrency[]) => rows.filter((row) => row.status === 'active'),
  });
}

// --- authoring the Kind onto a draft version ---------------------------------------------------

/**
 * `POST /rewards/:rewardId/versions` carrying the Kind/value pair.
 *
 * Not a `useMutation` hook: both callers already run it inside a multi-step submit (create the
 * reward, then author its Kind), where a plain awaited call reads far more honestly than a nested
 * mutation. Cache invalidation is the caller's — the versions list key belongs to
 * `features/versions/api.ts`.
 */
export async function createRewardVersionDraft(
  rewardId: number,
  input: CreateRewardVersionRequest,
): Promise<RewardVersion> {
  try {
    const payload = createRewardVersionRequestSchema.parse(input);
    const response = await api.post<unknown>(`/rewards/${String(rewardId)}/versions`, payload);
    const parsed = rewardVersionEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-reward-version response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}
