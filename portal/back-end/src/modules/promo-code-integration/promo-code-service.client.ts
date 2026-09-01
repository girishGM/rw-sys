/**
 * T-166 — the **first outbound write** this codebase makes to a service it does not own:
 * `POST /api/v1/campaign-promo-configs` on promo-code-service
 * (`promo-code-service-plan/04-API-CONTRACT.md` §2).
 *
 * ### Why this is not an extension of `FieldApiLookupHttpClient`
 *
 * That class (`modules/field-value-sources/field-value-source-lookup.service.ts`) states in its
 * own header that it is scoped to the read-only lookup-proxy case: GET only, no request body,
 * headers derived from a registry row's encrypted `auth_config`. This call is a `POST` with a JSON
 * body, authenticated by a process-level service token that belongs to no registry row — a
 * materially different contract. Widening that class to cover both would make "what can this
 * client do" a question you answer by reading the call sites. So: a second small client, and the
 * error-normalisation pattern copied deliberately rather than shared.
 *
 * ### The one invariant
 *
 * {@link PromoCodeServiceClient.bind} either **returns normally, meaning promo-code-service has
 * recorded the binding**, or it throws one of `promo-code-service.errors.ts`'s three errors.
 * There is no third outcome, and in particular no "probably worked" — `BindingsService` writes
 * the local rows only on the return path (see its `attachReward`), so an ambiguous answer here
 * would become a local record of a binding that does not exist remotely. Every `catch` below
 * exists to close one route to that ambiguity.
 *
 * ### Idempotency, and why there is no compensating unbind
 *
 * promo-code-service's bind deactivates any prior active binding for the same
 * `(tenant, level, ref)` and inserts a new row — never an in-place overwrite
 * (`01-DATABASE.md` §2, `uc_campaign_promo_config_active`). So a *repeated* bind of the same
 * triple is safe by construction: it leaves exactly one active row, the newest. That is what lets
 * `BindingsService` treat "remote bind succeeded, local transaction then failed" as recoverable by
 * the Maker simply retrying the attach, and is why T-166 built no unbind call for that window.
 * Unbind generally (`detachReward`) is deliberately out of scope — recorded in
 * `project-plan/BACKLOG.md`.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '@/config/env.schema';
import {
  PROMO_CODE_SERVICE_TIMEOUT_MS,
  PromoCodeConfigNotBindableError,
  PromoCodeServiceBindError,
  PromoCodeServiceBindTimeoutError,
} from './promo-code-service.errors';

/** The path §2 fixes. Joined to the configured base URL by {@link buildBindUrl}. */
const BIND_PATH = '/api/v1/campaign-promo-configs';

/**
 * `bind_level` as promo-code-service spells it — uppercase
 * (`CHECK (bind_level IN ('CAMPAIGN','TRACKER','COMPONENT'))`, `01-DATABASE.md` §2).
 *
 * The portal spells the same three values lowercase (`binding.dto.ts`'s `AttachRewardDto.level`).
 * **T-166 owns that mapping and neither service's schema changes for it** — see
 * {@link toBindLevel}. A shared uppercase enum would have made one of the two codebases spell its
 * own domain in the other's dialect, for a translation that costs one function.
 */
export type PromoCodeBindLevel = 'CAMPAIGN' | 'TRACKER' | 'COMPONENT';

/** The request body of §2, exactly. */
export interface PromoCodeBindRequest {
  /** The Maker's chosen config — the `promoCodeConfig` value carried on the attach request. */
  readonly promoCodeConfigId: string;
  readonly tenantId: number;
  readonly bindLevel: PromoCodeBindLevel;
  /** The campaign, tracker or component id the reward is being attached to. */
  readonly bindRefId: number;
  /** The Maker performing the attach. From the verified JWT, never from the request body (R3). */
  readonly boundBy: number;
}

/**
 * Maps the portal's own lowercase level to promo-code-service's uppercase `bindLevel`.
 *
 * Written as an explicit three-way map rather than `level.toUpperCase()` so that a fourth portal
 * level added one day fails to compile here instead of being sent to a service whose `CHECK`
 * constraint will reject it at the far end of a network call.
 */
export function toBindLevel(level: 'campaign' | 'tracker' | 'component'): PromoCodeBindLevel {
  switch (level) {
    case 'campaign':
      return 'CAMPAIGN';
    case 'tracker':
      return 'TRACKER';
    case 'component':
      return 'COMPONENT';
  }
}

@Injectable()
export class PromoCodeServiceClient {
  constructor(private readonly config: ConfigService<Env, true>) {}

  /**
   * Registers `request` with promo-code-service. Returns only when it answered `2xx`.
   *
   * The response body is deliberately **not** parsed or returned. §2 answers with the created
   * `campaign_promo_config` row, and the portal keeps no foreign key to it (the portal's own
   * record of the binding stays the opaque `reward_policies.config.promoCodeConfig` string T-127
   * writes). Reading a body we would immediately discard would only create a fourth failure mode
   * — "bound successfully, then failed to parse the receipt" — for no gain.
   */
  async bind(request: PromoCodeBindRequest): Promise<void> {
    const url = this.buildBindUrl();
    const token = this.config.get('PROMO_CODE_SERVICE_INTERNAL_TOKEN', { infer: true });

    if (typeof token !== 'string' || token === '') {
      // Fail closed, and say which knob is missing — in the *log*, never in the response.
      // Attaching locally without registering remotely is the one outcome this task exists to
      // prevent, so an unconfigured portal refuses the attach rather than half-performing it.
      throw new PromoCodeServiceBindError({
        logMessage:
          'promo-code-service bind refused: PROMO_CODE_SERVICE_INTERNAL_TOKEN is not configured',
      });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(PROMO_CODE_SERVICE_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new PromoCodeServiceBindTimeoutError({
          cause: error,
          logMessage: `promo-code-service bind timed out after ${String(PROMO_CODE_SERVICE_TIMEOUT_MS)}ms`,
          logContext: { url },
        });
      }
      // Connection refused, DNS failure, TLS failure, reset mid-flight — TC-3. None of these can
      // have created a binding, so refusing the attach loses nothing.
      throw new PromoCodeServiceBindError({
        cause: error,
        logMessage: 'promo-code-service bind failed before a response was received',
        logContext: { url },
      });
    }

    if (response.status === 409) {
      // §2's one *expected* rejection: the config is not `ACTIVE` for this tenant. A 4xx the
      // Maker can act on, never a 502 that tells them to try again later — see the errors file.
      throw new PromoCodeConfigNotBindableError({
        logMessage: 'promo-code-service refused the bind: config is not ACTIVE for this tenant',
        logContext: { url, promoCodeConfigId: request.promoCodeConfigId },
      });
    }

    if (!response.ok) {
      // Everything else, including promo-code-service's own `401` when the two services' tokens
      // disagree (TC-8). A misconfigured token is an *operator's* problem, not something the
      // Maker can fix by editing their campaign, so it surfaces as a 502 and the real status
      // goes to the log — where an operator will actually see it — rather than being swallowed.
      throw new PromoCodeServiceBindError({
        logMessage: `promo-code-service bind responded with status ${String(response.status)}`,
        logContext: { url, status: response.status },
      });
    }
  }

  /**
   * `PROMO_CODE_SERVICE_BASE_URL` + §2's path, with any trailing slash on the base removed so
   * `http://host/` and `http://host` produce the same URL rather than a `//api/v1/...` that some
   * routers 404 and others accept.
   */
  private buildBindUrl(): string {
    const baseUrl = this.config.get('PROMO_CODE_SERVICE_BASE_URL', { infer: true });
    if (typeof baseUrl !== 'string' || baseUrl === '') {
      throw new PromoCodeServiceBindError({
        logMessage:
          'promo-code-service bind refused: PROMO_CODE_SERVICE_BASE_URL is not configured',
      });
    }
    return `${baseUrl.replace(/\/+$/, '')}${BIND_PATH}`;
  }
}
