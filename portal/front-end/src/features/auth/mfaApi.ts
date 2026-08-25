/**
 * T-060 — the three `/auth/mfa/*` calls this feature makes
 * (`back-end/src/modules/auth/mfa.controller.ts`, `dto/mfa-request.dto.ts`,
 * `dto/mfa-response.dto.ts`).
 *
 * Mirrors `./api.ts`'s own shape exactly — same `postXxxData` pattern, same "go through the
 * shared `api` client (T-022) rather than a bare axios instance" reasoning (see that file's own
 * banner for why). `enrolMfa`/`verifyMfa`/`recoverMfa` are the entire vocabulary
 * `MfaChallengePage.tsx` needs; nothing here renders anything.
 *
 * ### The pending token never appears in a request body here
 *
 * `mfa-request.dto.ts` accepts an optional `mfaPendingToken` field (02-SECURITY.md §2a's literal
 * shape — a scripted client may send it there), but every call below omits it. The token already
 * travels automatically in the `__Host-rs_mfa` cookie `POST /auth/login` sets
 * (`mfa.constants.ts`), so there is nothing for this client to hold, store, or risk placing
 * somewhere R5 would call a leak. `mfa.controller.ts`'s own `pendingTokenFrom` reads the body
 * first and falls back to the cookie — omitting the body field here is what makes it fall
 * through to the cookie every time.
 *
 * ### `enrolMfa` doubles as the "am I enrolled yet?" check
 *
 * There is no fourth, read-only `/auth/mfa/status` route (T-055's "Files owned" list is closed,
 * and no task adds one) — see `MfaChallengePage.tsx`'s own header for how this file's two
 * possible outcomes for `enrolMfa` (a fresh offer, or `MFA_ALREADY_ENROLLED`) become the two
 * entry states that screen renders.
 */
import { z } from 'zod';
import { portalRoleSchema, type SharedPortalRole } from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

/**
 * `system_messages` keys this feature branches on, duplicated from
 * `back-end/src/modules/auth/mfa.constants.ts#MFA_ERROR_CODE` for the same reason `./api.ts`'s
 * own `AUTH_ERROR_CODE` is (that file's own comment): the back end is not importable from the
 * SPA, and these are not part of `packages/shared` (out of this task's file scope, R9).
 */
export const MFA_ERROR_CODE = Object.freeze({
  /** 403 — `POST /auth/mfa/enrol` when the account already has a confirmed factor (TC-2). This
   * is also the signal `MfaChallengePage.tsx` uses to skip straight to the challenge (TC-4). */
  ALREADY_ENROLLED: 'MFA_ALREADY_ENROLLED',
  /** 401 on any of the three routes — an absent, expired or forged pending token
   * (`auth.exceptions.ts#SessionInvalidHttpException`). The only correct reaction is to start
   * again at `/login` (TC-12, TC-13). */
  SESSION_INVALID: 'AUTH_SESSION_INVALID',
});

const enrolmentResponseSchema = z
  .object({
    secret: z.string(),
    otpauthUri: z.string(),
    issuer: z.string(),
    account: z.string(),
    algorithm: z.string(),
    digits: z.number(),
    periodSeconds: z.number(),
  })
  .strict();

/** Mirrors `MfaEnrolmentResponseDto` (`dto/mfa-response.dto.ts`) exactly. */
export interface MfaEnrolmentOffer {
  readonly secret: string;
  readonly otpauthUri: string;
  readonly issuer: string;
  readonly account: string;
  readonly algorithm: string;
  readonly digits: number;
  readonly periodSeconds: number;
}

const challengeResponseSchema = z
  .object({
    role: portalRoleSchema,
    mustChangePassword: z.boolean(),
    mfaRequired: z.boolean(),
    recoveryCodes: z.array(z.string()).optional(),
    recoveryCodesRemaining: z.number().optional(),
  })
  .strict();

/**
 * What a satisfied challenge produces. `mfaRequired` (always `false` here — see
 * `MfaVerifiedResponseDto`'s own comment) is deliberately not surfaced: the caller already knows
 * the challenge is over by virtue of holding this value.
 */
export interface MfaChallengeResult {
  readonly role: SharedPortalRole;
  readonly mustChangePassword: boolean;
  /** Present exactly once, on the call that completes an enrolment (TC-1). Absent on every
   * ordinary challenge or recovery. */
  readonly recoveryCodes?: readonly string[];
  /** Present on the recovery path only (TC-11). */
  readonly recoveryCodesRemaining?: number;
}

async function postMfaData<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  try {
    const response = await api.post<{ data: unknown }>(path, body);
    const parsed = schema.safeParse(response.data.data);
    if (!parsed.success) {
      throw new Error(
        `${path} response did not match the expected shape: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  } catch (error) {
    throw toApiError(error);
  }
}

function toResult(parsed: z.infer<typeof challengeResponseSchema>): MfaChallengeResult {
  return {
    role: parsed.role,
    mustChangePassword: parsed.mustChangePassword,
    recoveryCodes: parsed.recoveryCodes,
    recoveryCodesRemaining: parsed.recoveryCodesRemaining,
  };
}

/**
 * `POST /auth/mfa/enrol` — mints a seed and shows it once (TC-1), or answers
 * `403 MFA_ALREADY_ENROLLED` (TC-2) for an account that already has one. See this file's own
 * header for why a single call answers both "give me a seed" and "am I enrolled".
 */
export function enrolMfa(): Promise<MfaEnrolmentOffer> {
  return postMfaData('/auth/mfa/enrol', {}, enrolmentResponseSchema);
}

/**
 * `POST /auth/mfa/verify` — the TOTP challenge, and the second half of enrolment. The server
 * decides which one this call is (`mfa.service.ts#verifyChallenge`); `result.recoveryCodes`
 * being present is how the caller finds out it just completed an enrolment (TC-6).
 */
export function verifyMfa(totpCode: string): Promise<MfaChallengeResult> {
  return postMfaData('/auth/mfa/verify', { totpCode }, challengeResponseSchema).then(toResult);
}

/** `POST /auth/mfa/recover` — one single-use recovery code, for a lost device (TC-11). */
export function recoverMfa(recoveryCode: string): Promise<MfaChallengeResult> {
  return postMfaData('/auth/mfa/recover', { recoveryCode }, challengeResponseSchema).then(toResult);
}
