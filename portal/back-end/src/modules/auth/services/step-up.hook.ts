/**
 * T-011 — the step-up extension point, required verbatim by the task file:
 *
 * > *"Also leave a documented extension point (an injectable step-up hook called after password
 * > verification, currently a no-op) rather than treating single-factor login as structurally
 * > final — see `BACKLOG.md` B-02 and the new T-055, which is expected to fill this hook for
 * > `super_admin` without reopening this task's auth flow."*
 *
 * ### What "without reopening this task's auth flow" means concretely
 *
 * `AuthService.login` calls {@link StepUpHook.evaluate} at exactly one point: **after** the
 * password has been verified and **before** a session is created. That ordering is the whole
 * design. 02-SECURITY.md §2 step 7 requires that a `super_admin` awaiting MFA gets *no session
 * and no refresh token* — only a short-lived `MFA_PENDING` token — so a hook that ran after
 * session creation would have to tear one down again, and a hook that ran before password
 * verification would confirm to an attacker that MFA is enabled on an account they have not yet
 * authenticated to.
 *
 * T-055 replaces {@link NoopStepUpHook} in `auth.module.ts`'s provider array — one line — and
 * needs to change nothing else in the login path.
 *
 * ### Why the no-op returns `required: false` rather than throwing "not implemented"
 *
 * Because single-factor login is the *correct* behaviour for five of the six roles and remains
 * so after T-055 (`BACKLOG.md` B-02: MFA stays optional and self-service for everyone except
 * `super_admin`). This is not a stub standing in for missing work; it is the real
 * implementation of "no step-up is required", which most sessions will keep using forever.
 */
import { Injectable } from '@nestjs/common';
import type { AuthUserRow } from './credential.repository';

/**
 * The hook's answer.
 *
 * Deliberately minimal. It says *whether* a second factor is outstanding and nothing about what
 * that factor is or how to satisfy it — that is T-055's business, and encoding TOTP-shaped
 * assumptions here would be exactly the premature coupling this seam exists to avoid.
 */
export interface StepUpDecision {
  /** When `true`, the caller must not create a session or issue any cookie. */
  readonly required: boolean;
  /**
   * **Added by T-055.** The opaque credential the caller may use to *satisfy* the outstanding
   * factor, when the hook has one to offer.
   *
   * Deliberately typed as an opaque string and named for its lifecycle rather than its mechanism:
   * this interface still says nothing about what the second factor is or how it is checked, which
   * is the property the header above describes. `AuthService` does not read it, parse it or
   * validate it — it passes it to the transport layer, which puts it in a cookie.
   *
   * Optional, so `NoopStepUpHook` and every future hook that has nothing to hand back (a WebAuthn
   * challenge posted separately, say) remain valid implementations with no change.
   */
  readonly pendingToken?: string;
}

export interface StepUpHook {
  /**
   * Called once per successful password verification, with the **database** user row — not with
   * anything the client sent.
   */
  evaluate(user: AuthUserRow): Promise<StepUpDecision>;
}

/** DI token. `AuthService` depends on {@link StepUpHook}, never on a concrete class. */
export const STEP_UP_HOOK = Symbol('STEP_UP_HOOK');

/** The default: no second factor is outstanding. See this file's header for why that is real. */
@Injectable()
export class NoopStepUpHook implements StepUpHook {
  async evaluate(_user: AuthUserRow): Promise<StepUpDecision> {
    return { required: false };
  }
}
