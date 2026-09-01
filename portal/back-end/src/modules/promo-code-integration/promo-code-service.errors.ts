/**
 * T-166 — the three ways a bind against promo-code-service can end badly, expressed in this
 * application's own error vocabulary rather than in whatever the network threw.
 *
 * ### Why a separate file, and why exactly three
 *
 * `promo-code-service.client.ts` normalises **every** failure mode into one of these before it
 * returns: a DNS failure, a connection reset, a 500, a 401, an HTML error page, a body that is
 * not JSON, an unset base URL. Nothing else escapes — the same contract
 * `FieldApiLookupHttpClient` states for the read-only lookup proxy (see its header), for the same
 * reason: `BindingsService` has one decision to make ("did the remote binding happen?") and it
 * cannot make it from a `TypeError`.
 *
 * The split between them is the split a caller can act on:
 *
 *  - **502** {@link PromoCodeServiceBindError} — *we* could not get an answer, or got one we do
 *    not understand. Retrying later may work. Nothing about the Maker's request is known to be
 *    wrong.
 *  - **504** {@link PromoCodeServiceBindTimeoutError} — the same, but specifically "it did not
 *    answer in time", which is the one an operator diagnoses differently (the service is up and
 *    slow, not down).
 *  - **409** {@link PromoCodeConfigNotBindableError} — promo-code-service **did** answer, and its
 *    answer was that this config is not `ACTIVE` for this tenant (`04-API-CONTRACT.md` §2). This
 *    is the Maker's to fix: pick a different config, or have the config activated. Deliberately
 *    *not* folded into the 502: a 5xx tells a Maker "try again later", and trying again later
 *    with the same archived config will fail forever.
 *
 * `PROMO_CODE_SERVICE_BASE_URL`/`PROMO_CODE_SERVICE_INTERNAL_TOKEN` being unset is a 502 and not
 * a boot failure — see `env.schema.ts`'s T-166 block for why the fail-closed direction is chosen
 * at call time rather than at startup.
 */
import { AppError, type AppErrorOptions } from '@/common/errors/app-error';

export const PROMO_CODE_SERVICE_ERROR_CODE = Object.freeze({
  /** 502 — no usable answer from promo-code-service. Covers "not configured" too. */
  PROMO_CODE_SERVICE_BIND_FAILED: 'PROMO_CODE_SERVICE_BIND_FAILED',
  /** 504 — no answer within {@link PROMO_CODE_SERVICE_TIMEOUT_MS}. */
  PROMO_CODE_SERVICE_BIND_TIMEOUT: 'PROMO_CODE_SERVICE_BIND_TIMEOUT',
  /** 409 — the config is not `ACTIVE` for this tenant. The Maker can act on this one. */
  PROMO_CODE_CONFIG_NOT_BINDABLE: 'PROMO_CODE_CONFIG_NOT_BINDABLE',
});

/**
 * How long a bind may take before this portal gives up on the Maker's behalf. The same 5s
 * `FieldApiLookupHttpClient` uses for the lookup proxy — one number for "how long we wait on
 * promo-code-service", rather than two that can drift apart for no stated reason.
 */
export const PROMO_CODE_SERVICE_TIMEOUT_MS = 5000;

/**
 * 502 — TC-3, TC-8. `logMessage`/`logContext` carry the operator-facing detail (which status came
 * back, which URL was called); neither ever reaches the client, per `app-error.ts`'s header. That
 * matters here more than usual: the bearer token and the upstream's own error body must never end
 * up in a response, and the only way to guarantee that is to never put them in `details`.
 */
export class PromoCodeServiceBindError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(PROMO_CODE_SERVICE_ERROR_CODE.PROMO_CODE_SERVICE_BIND_FAILED, 502, options);
  }
}

/** 504 — TC-4. The timeout half of {@link PromoCodeServiceBindError}. */
export class PromoCodeServiceBindTimeoutError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(PROMO_CODE_SERVICE_ERROR_CODE.PROMO_CODE_SERVICE_BIND_TIMEOUT, 504, options);
  }
}

/**
 * 409 — TC-2. Carries a `details` entry naming `promoCodeConfig`, because that is the one field
 * of the Maker's request they can change to make this succeed. `details` is otherwise reserved
 * for validation failures (`app-error.ts`); this is a validation failure in every sense except
 * which process performed it.
 */
export class PromoCodeConfigNotBindableError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(PROMO_CODE_SERVICE_ERROR_CODE.PROMO_CODE_CONFIG_NOT_BINDABLE, 409, {
      details: [{ field: 'promoCodeConfig', code: 'CONFIG_NOT_ACTIVE' }],
      ...options,
    });
  }
}
