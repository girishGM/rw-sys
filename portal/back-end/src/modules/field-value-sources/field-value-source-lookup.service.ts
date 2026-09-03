/**
 * T-123 — the two runtime endpoints a Maker's value-source dropdown actually calls
 * (`13-REWARD-MASTER-VALUE-SOURCES.md` §3): a **context lookup**, which reads the in-progress
 * campaign draft itself with no network call, and an **API lookup**, which proxies a
 * pre-registered external endpoint server-side so its credentials never reach the browser.
 *
 * Both go through `ScopedRepository`/`FieldValueSourceRegistriesService` (R2) rather than a raw
 * `Model.findAll`, and neither is gated by a permission — see the controller header for why every
 * authenticated role may call them.
 *
 * ### The exact shape a context-lookup response carries, for T-125
 *
 * `13-REWARD-MASTER-VALUE-SOURCES.md` §3 asks this task to "document this edge case's exact
 * returned shape" since nothing upstream fixes it. Every item is:
 *
 * ```jsonc
 * { "value": 42, "label": "Scan receipt", "componentCode": "SCAN_01", "sequenceOrder": 1 }
 * ```
 *
 * `value` is the `tracker_components.id` a Maker's chosen field ends up storing (the same integer
 * `bindings.service.ts`'s `toComponentId` expects back). `label` is `TrackerComponent.name` — the
 * same "human label, machine value" pairing the API-lookup side already documents via
 * `response_value_key`/`response_label_key`, so a single frontend picker component can bind either
 * source without a branch. `componentCode`/`sequenceOrder` are included for a richer T-125 UI
 * (e.g. showing "Step 1 · SCAN_01") — additive fields a caller that only wants `{value,label}` can
 * ignore.
 *
 * ### Deviations recorded here rather than guessed silently (AGENT-PROTOCOL §3)
 *
 *  - The task's illustrative `{ "message": "…" }` 501 body is **not** used verbatim: every other
 *    error response in this application carries T-014's `{ error: { code, message, traceId } }`
 *    envelope, and inventing a one-off shape here would be the one endpoint in the whole API a
 *    client cannot parse generically. `FieldLookupProviderNotAvailableError` produces a 501 through
 *    that same envelope instead — the *status code* and *"not available yet"* meaning are
 *    preserved, the wire shape is not forked.
 *  - `auth_type = 'mtls'` is accepted by T-121's registry (open `varchar` + `CHECK`, not a rigid
 *    enum — "since none of this is confirmed yet") but has no working implementation here: a
 *    client-certificate call needs a custom `fetch` dispatcher and no seeded or hypothetical
 *    provider uses it yet. An `active` `mtls` provider therefore fails closed with a 502 rather
 *    than attempting a call with no certificate — see {@link buildAuthHeaders}. Flagged for the
 *    architect in the completion report, not silently implemented or silently ignored.
 *  - An `inactive` API lookup provider is declined the same way `planned` is (implementation note
 *    2 only spells out `planned`/`active`). Calling a provider its own owner has switched off would
 *    otherwise silently fall through to "attempt the call", which is the wrong default for a
 *    status column that exists specifically to gate calls.
 *  - `excludeComponentId` supplied but not a member of the tracker (wrong tracker, deleted
 *    component, or a stale UI) is a 400, not a silent "treat as omitted". Silently returning the
 *    unfiltered list here would be exactly the gap `13-REWARD-MASTER-VALUE-SOURCES.md` §3's
 *    circular-dependency rule exists to close — this endpoint's whole job is filtering out what a
 *    Maker must not be offered.
 *
 * ### T-172 — the outbound request now carries the caller's own `tenantId`
 *
 * Filed as a defect against this task's own design: `apiLookup` called the provider's stored
 * `endpoint_url` verbatim, with no per-request parameters at all. That is fine for a genuinely
 * global upstream, but promo-code-service's real `GET /api/v1/promo-code-configs`
 * (`04-API-CONTRACT.md` §1, `promo-code-service-plan`) is **tenant-scoped by design** — it
 * requires a `tenantId` query parameter and 400s without one — so every call this proxy made on a
 * Maker's behalf was answered 400 by the upstream and normalised to a 502 here, unconditionally.
 *
 * No column on `field_api_lookup_providers` can fix this (R1 forbids adding one without an
 * architect decision, and T-121's schema has none today): the missing value isn't a per-provider
 * constant, it's per-request, per-caller data that only exists once a request is authenticated.
 * The fix therefore lives entirely in this method: `apiLookup` now takes the caller's own
 * `tenantId` — read from the verified JWT via `@CurrentUser()` in the controller, never from a
 * DTO (R3) — and appends it as a `?tenantId=` query parameter on every outbound request, via
 * {@link appendTenantId}. `null` (a caller with no tenant scope, e.g. a country-only or global
 * Super Admin) omits the parameter entirely rather than sending an empty one, leaving the
 * upstream's own validation — and this class's existing 400→502 normalisation — to report it,
 * exactly as every caller shape behaved before this fix. This is a generic convention for *every*
 * active provider, not a `PROMO_CODE_CONFIG_SERVICE` special case: every upstream this proxy is
 * confirmed to call is part of the same multi-tenant system this portal itself is, and appending
 * an extra query parameter an upstream doesn't ask for is harmless.
 */
import { Injectable } from '@nestjs/common';
import {
  AppError,
  NotFoundError,
  ValidationFailedError,
  type AppErrorOptions,
} from '@/common/errors/app-error';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import {
  FieldApiLookupProvider,
  FieldContextProvider,
  Tracker,
  TrackerComponent,
  TrackerTrackerComponent,
} from '@/database/models';
import { FieldValueSourceRegistriesService } from './field-value-source-registries.service';

/** The one context provider with real filtering logic (implementation note 1). Every other
 * seeded/future context provider (`JOURNEY_COMPONENTS` today) returns the tracker's full list. */
const SIBLING_COMPONENTS_PROVIDER_CODE = 'SIBLING_COMPONENTS';

/** Bounds how long an API lookup provider's endpoint may take before this task gives up on its
 * behalf (implementation note 2: "a failed/slow call surfaces as a clean 502/504"). Not
 * configurable per provider — T-121's schema carries no such column, and no confirmed provider
 * has stated a requirement for one yet. */
const UPSTREAM_LOOKUP_TIMEOUT_MS = 5000;

export const FIELD_VALUE_SOURCE_LOOKUP_ERROR_CODE = Object.freeze({
  /** 501 — `status: 'planned'` or `'inactive'`. No network call is ever attempted for either. */
  FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE: 'FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE',
  /** 502 — the upstream call failed, returned a non-2xx status, returned a body this task cannot
   * parse as JSON, or returned JSON that is not the array §3 says every provider returns. */
  FIELD_API_LOOKUP_UPSTREAM_ERROR: 'FIELD_API_LOOKUP_UPSTREAM_ERROR',
  /** 504 — the upstream call did not answer within {@link UPSTREAM_LOOKUP_TIMEOUT_MS}. */
  FIELD_API_LOOKUP_UPSTREAM_TIMEOUT: 'FIELD_API_LOOKUP_UPSTREAM_TIMEOUT',
});

/** 501 — TC-4. Deliberately carries no `details`; there is nothing a client can fix by retrying
 * with a different body, only by waiting for the provider to be flipped to `active`. */
export class FieldLookupProviderNotAvailableError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(FIELD_VALUE_SOURCE_LOOKUP_ERROR_CODE.FIELD_LOOKUP_PROVIDER_NOT_AVAILABLE, 501, options);
  }
}

/** 502 — TC-7. `logMessage`/`logContext` carry whatever detail is useful for an operator; neither
 * ever reaches the client (see `app-error.ts`'s header — this is exactly the mechanism that keeps
 * a stack trace or a decrypted `auth_config` out of the response body). */
export class FieldApiLookupUpstreamError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(FIELD_VALUE_SOURCE_LOOKUP_ERROR_CODE.FIELD_API_LOOKUP_UPSTREAM_ERROR, 502, options);
  }
}

/** 504 — TC-7's timeout variant. */
export class FieldApiLookupUpstreamTimeoutError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(FIELD_VALUE_SOURCE_LOOKUP_ERROR_CODE.FIELD_API_LOOKUP_UPSTREAM_TIMEOUT, 504, options);
  }
}

/** What both endpoints ultimately hand back for the Maker's dropdown to bind to. */
export interface FieldValueOption {
  readonly value: string | number;
  readonly label: string;
}

/** {@link FieldValueOption}, plus the two fields the context-lookup response adds — see this
 * file's header for why they exist and why they are safe for a caller to ignore. */
export interface ContextComponentOption extends FieldValueOption {
  readonly value: number;
  readonly componentCode: string;
  readonly sequenceOrder: number;
}

/**
 * A thin, mockable seam around the platform `fetch`. Not a generic HTTP client — it exists
 * solely so {@link FieldValueSourceLookupService}'s unit tests can substitute a double for TC-4's
 * "assert the HTTP client was never invoked" and TC-6/TC-7's mocked-response scenarios, without
 * reaching for a module-level `fetch` mock. The real implementation is exercised for real against
 * a local HTTP server in this class's own spec — see that file's header for why a mocked
 * `Response` object would not prove the timeout/error behaviour actually holds (AGENT-PROTOCOL
 * §3: "assert the observable property, not the implementation string").
 */
@Injectable()
export class FieldApiLookupHttpClient {
  /**
   * Calls `url`, decodes the body as JSON, and normalises every failure mode implementation note
   * 2 names into one of this module's own `AppError`s — nothing else this class can throw (a raw
   * `TypeError` from a malformed `url`, a DNS failure, a connection reset) is allowed to escape
   * to the caller, which is what keeps the 502/504 contract "clean" per that note.
   */
  async requestJson(
    url: string,
    method: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(UPSTREAM_LOOKUP_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new FieldApiLookupUpstreamTimeoutError({
          cause: error,
          logMessage: `field-api-lookup request to upstream timed out after ${UPSTREAM_LOOKUP_TIMEOUT_MS}ms`,
        });
      }
      throw new FieldApiLookupUpstreamError({
        cause: error,
        logMessage: 'field-api-lookup request failed before a response was received',
      });
    }

    if (!response.ok) {
      throw new FieldApiLookupUpstreamError({
        logMessage: `field-api-lookup upstream responded with status ${response.status}`,
        logContext: { status: response.status },
      });
    }

    try {
      return await response.json();
    } catch (error) {
      throw new FieldApiLookupUpstreamError({
        cause: error,
        logMessage: 'field-api-lookup upstream response was not valid JSON',
      });
    }
  }
}

@Injectable()
export class FieldValueSourceLookupService {
  constructor(
    private readonly scoped: ScopedRepository,
    private readonly registries: FieldValueSourceRegistriesService,
    private readonly httpClient: FieldApiLookupHttpClient,
  ) {}

  /** `GET /field-value-sources/context/:providerCode`. */
  async contextLookup(
    providerCode: string,
    trackerId: number,
    excludeComponentId?: number,
  ): Promise<ContextComponentOption[]> {
    const provider = await this.findContextProviderOrFail(providerCode);

    // `findByPkOrFail` folds "does not exist" and "exists, out of scope" into the same 404
    // (02-SECURITY.md §5.1) — exactly TC-3's "unknown trackerId" case.
    await this.scoped.findByPkOrFail(Tracker, trackerId);

    const links = (await this.scoped.listAll(TrackerTrackerComponent, {
      where: { trackerId },
      include: [TrackerComponent],
      order: [['sequenceOrder', 'ASC']],
    })) as Array<TrackerTrackerComponent & { component: TrackerComponent }>;

    const options = links.map(toContextOption);

    // Implementation note 1: only `SIBLING_COMPONENTS` filters. `JOURNEY_COMPONENTS` — and any
    // future context provider this task did not anticipate — returns the full, unfiltered list.
    if (provider.providerCode !== SIBLING_COMPONENTS_PROVIDER_CODE) {
      return options;
    }

    if (excludeComponentId === undefined) {
      // A brand-new, not-yet-saved component: nothing to exclude yet, and nothing later than
      // "not yet placed" exists to filter against (implementation note 1).
      return options;
    }

    const own = links.find((link) => link.componentId === excludeComponentId);
    if (own === undefined) {
      // See this file's header — silently falling back to the unfiltered list here would defeat
      // the reason this endpoint exists.
      throw new ValidationFailedError([
        { field: 'excludeComponentId', code: 'COMPONENT_NOT_IN_TRACKER' },
      ]);
    }

    return options.filter((option) => option.sequenceOrder < own.sequenceOrder);
  }

  /**
   * `GET /field-value-sources/api/:providerCode`.
   *
   * `tenantId` is the caller's own, verified tenant scope (`AuthenticatedUser.tenantId`, R3) —
   * see this file's header, "T-172", for why it exists as a parameter here and how it is used.
   */
  async apiLookup(providerCode: string, tenantId: number | null): Promise<FieldValueOption[]> {
    const provider = await this.findApiLookupProviderOrFail(providerCode);

    if (provider.status !== 'active') {
      // `planned` (implementation note 2) and `inactive` (see this file's header) both decline
      // without ever attempting a call — TC-4's own assertion is that the HTTP client is untouched.
      throw new FieldLookupProviderNotAvailableError();
    }

    const authConfig = await this.registries.getAuthConfigForLookup(provider.id);
    const headers = buildAuthHeaders(provider.authType, authConfig);

    const body = await this.httpClient.requestJson(
      appendTenantId(provider.endpointUrl, tenantId),
      provider.httpMethod,
      headers,
    );

    if (!Array.isArray(body)) {
      throw new FieldApiLookupUpstreamError({
        logMessage: 'field-api-lookup upstream response was not a JSON array',
      });
    }

    return body.map((entry) =>
      toApiOption(entry, provider.responseValueKey, provider.responseLabelKey),
    );
  }

  private async findContextProviderOrFail(providerCode: string): Promise<FieldContextProvider> {
    const [row] = await this.scoped.listAll(FieldContextProvider, {
      where: { providerCode },
      limit: 1,
    });
    if (row === undefined) throw new NotFoundError();
    return row;
  }

  private async findApiLookupProviderOrFail(providerCode: string): Promise<FieldApiLookupProvider> {
    const [row] = await this.scoped.listAll(FieldApiLookupProvider, {
      where: { providerCode },
      limit: 1,
    });
    if (row === undefined) throw new NotFoundError();
    return row;
  }
}

// --- helpers -------------------------------------------------------------------------------

function toContextOption(
  link: TrackerTrackerComponent & { component: TrackerComponent },
): ContextComponentOption {
  return {
    value: link.componentId,
    label: link.component.name,
    componentCode: link.component.componentCode,
    sequenceOrder: link.sequenceOrder,
  };
}

/**
 * T-172 — appends the caller's own `tenantId` (verified JWT only, never client-supplied — R3) as
 * a `tenantId` query parameter on `endpointUrl`, so a tenant-scoped upstream (promo-code-service's
 * `GET /api/v1/promo-code-configs`, confirmed by reading `04-API-CONTRACT.md` §1 and its own
 * `parseListPromoCodeConfigsQuery`) sees the same parameter every other tenant-scoped call in this
 * system carries, instead of nothing at all.
 *
 * `tenantId === null` (a caller with no tenant scope) leaves `endpointUrl` untouched — see this
 * file's header for why that is the deliberate, unchanged behaviour for that caller shape, not a
 * gap this task closes.
 *
 * Deliberately not `new URL(endpointUrl)`: `endpoint_url` has no format validation at the DTO
 * layer (`create-field-api-lookup-provider.dto.ts` — plain `@IsString()`, no `@IsUrl()`), a
 * handful of this module's own tests store a bare placeholder like `'u'` for provider rows that
 * are never actually dispatched to `fetch`, and a malformed value must still fail the same clean
 * 502 `FieldApiLookupHttpClient.requestJson` already produces for a bad URL — not throw a raw,
 * unhandled `TypeError` out of a URL parser before that class is even reached.
 */
function appendTenantId(endpointUrl: string, tenantId: number | null): string {
  if (tenantId === null) return endpointUrl;
  const separator = endpointUrl.includes('?') ? '&' : '?';
  return `${endpointUrl}${separator}tenantId=${encodeURIComponent(String(tenantId))}`;
}

/**
 * Builds the headers `FieldApiLookupHttpClient` sends, from the provider's `authType` and its
 * decrypted `authConfig` (`null` when the provider has none — `FieldApiLookupConfigCrypto`'s own
 * contract, see its header, is that T-123 "treats `null` as 'this provider is not usable'").
 *
 * Every branch that cannot produce a usable header set declines with the same 502 a failed
 * network call would produce, rather than crashing or silently sending an unauthenticated
 * request to a provider that expects one — both are the "safe direction to fail" the crypto
 * helper's own header asks for.
 */
function buildAuthHeaders(
  authType: string,
  config: Record<string, unknown> | null,
): Record<string, string> {
  switch (authType) {
    case 'none':
      return {};

    case 'bearer': {
      const token = config?.token;
      if (typeof token !== 'string' || token === '') {
        throw new FieldApiLookupUpstreamError({
          logMessage: 'bearer-auth provider has no usable token in its decrypted authConfig',
        });
      }
      return { Authorization: `Bearer ${token}` };
    }

    case 'api_key': {
      const value = config?.value;
      if (typeof value !== 'string' || value === '') {
        throw new FieldApiLookupUpstreamError({
          logMessage: 'api_key-auth provider has no usable value in its decrypted authConfig',
        });
      }
      const headerName =
        typeof config?.headerName === 'string' && config.headerName !== ''
          ? config.headerName
          : 'X-Api-Key';
      return { [headerName]: value };
    }

    default:
      // `mtls`, and anything else a future registry row names — see this file's header.
      throw new FieldApiLookupUpstreamError({
        logMessage: `field-api-lookup provider uses an auth_type this task does not implement: "${authType}"`,
      });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** `response_value_key ` may point at a number or a string in the upstream's own JSON; anything
 * else (missing key, object, array) is coerced to a string rather than silently dropped. */
function toValue(raw: unknown): string | number {
  if (typeof raw === 'number' || typeof raw === 'string') return raw;
  return raw === undefined || raw === null ? '' : String(raw);
}

function toLabel(raw: unknown): string {
  return typeof raw === 'string' ? raw : toValue(raw).toString();
}

function toApiOption(entry: unknown, valueKey: string, labelKey: string): FieldValueOption {
  const record = isRecord(entry) ? entry : {};
  return { value: toValue(record[valueKey]), label: toLabel(record[labelKey]) };
}
