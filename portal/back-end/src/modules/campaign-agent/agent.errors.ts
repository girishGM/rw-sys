/**
 * T-048 — the error codes the agent introduces.
 *
 * Same convention `campaigns.errors.ts` records for itself: none of these has a `system_messages`
 * row yet, because seed migrations live in `back-end/src/database/migrations/**` and this task
 * owns exactly one file there. `MessageService` degrades to returning the key, which is safe (no
 * internal detail) but unlocalised until a seed migration adds them. Flagged in the completion
 * report.
 *
 * ### Why {@link UnresolvableOptionError} is a 400 and says nothing about what it rejected
 *
 * It is the error a *hallucinated or injected* option id produces (TC-7, TC-8, TC-10), so its
 * body is the one thing an attacker probing the agent would read. It names the option *kind* and
 * nothing else: not whether the id exists in another tenant, not whether it exists at all. A
 * merchant id from tenant B and a merchant id from nowhere produce byte-identical responses, which
 * is 02-SECURITY.md §5.1's rule applied to a surface the design doc calls out by name — *"an
 * attacker who fully controls the model's output can still only select from options the maker was
 * already entitled to select"*.
 */
import { AppError, BusinessRuleError, type AppErrorOptions } from '@/common/errors/app-error';

export const AGENT_ERROR_CODE = Object.freeze({
  /** The model, or a prompt injection speaking through it, referenced an option that was never
   * offered or no longer resolves in the maker's scope (TC-7, TC-8, TC-9, TC-10). */
  AGENT_OPTION_NOT_RESOLVABLE: 'AGENT_OPTION_NOT_RESOLVABLE',
  /** `POST /confirm` carried a hash that does not match the plan rebuilt from the stored slots
   * (TC-14, TC-15). */
  AGENT_PLAN_HASH_MISMATCH: 'AGENT_PLAN_HASH_MISMATCH',
  /** A plan was asked for, or confirmed, before the slots were complete. */
  AGENT_PLAN_INCOMPLETE: 'AGENT_PLAN_INCOMPLETE',
  /** The deterministic policy engine refused (§6). Carries one detail per violation. */
  AGENT_POLICY_VIOLATION: 'AGENT_POLICY_VIOLATION',
  /** The model is unreachable or unusable. The wizard remains the full-capability path (§9,
   * TC-24). */
  AGENT_LLM_UNAVAILABLE: 'AGENT_LLM_UNAVAILABLE',
  /** An action attempted on a session that has already been created, abandoned or errored. */
  AGENT_SESSION_NOT_ACTIVE: 'AGENT_SESSION_NOT_ACTIVE',
  /** The runaway guard — see `MAX_TURNS_PER_SESSION`. */
  AGENT_SESSION_EXHAUSTED: 'AGENT_SESSION_EXHAUSTED',
});

/** 400 — see this file's header for why the message is deliberately uninformative. */
export class UnresolvableOptionError extends AppError {
  constructor(kind: string, options: AppErrorOptions = {}) {
    super(AGENT_ERROR_CODE.AGENT_OPTION_NOT_RESOLVABLE, 400, {
      ...options,
      details: [{ field: 'optionId', code: `KIND_${kind.toUpperCase()}` }],
      // The *log* may say which token was rejected — that is an operator's evidence of an
      // injection attempt, and it never reaches a client (see `AppError`'s own header).
      logContext: { ...options.logContext, kind },
    });
  }
}

/**
 * 409 — the hash gate (§3.2).
 *
 * A 409 rather than a 400: the request is well-formed and the caller is entitled to make it; what
 * has happened is that the state moved underneath them, which is exactly what 03-API-CONTRACT.md
 * §1 assigns 409 to. The client's correct response is to re-fetch the plan and show it again,
 * which is a different behaviour from "fix your request" and deserves a different status.
 */
export class PlanHashMismatchError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(AGENT_ERROR_CODE.AGENT_PLAN_HASH_MISMATCH, 409, options);
  }
}

/** 422 — a plan was requested before the conversation had everything it needs. `details` lists
 * the missing slot keys so the UI can say which. */
export class PlanIncompleteError extends BusinessRuleError {
  constructor(missing: readonly string[], options: AppErrorOptions = {}) {
    super(AGENT_ERROR_CODE.AGENT_PLAN_INCOMPLETE, {
      ...options,
      details: missing.map((key) => ({ field: 'slots', code: `MISSING_${key.toUpperCase()}` })),
    });
  }
}

/**
 * 422 — the deterministic policy engine refused (§6).
 *
 * *"A violation is returned to the LLM as a **structured error to explain to the user**, not as
 * something for it to work around."* That is why the violation codes travel in `details`: the
 * chat turn renders them, the model explains them, and neither can negotiate them away.
 */
export class PolicyViolationError extends BusinessRuleError {
  constructor(codes: readonly string[], options: AppErrorOptions = {}) {
    super(AGENT_ERROR_CODE.AGENT_POLICY_VIOLATION, {
      ...options,
      details: codes.map((code) => ({ field: 'plan', code })),
    });
  }
}

/**
 * 503 — the model is not answering (§9, TC-24).
 *
 * Deliberately a 503 and not a 500: nothing is broken in the portal, one optional accelerator is
 * unavailable, and the wizard is unaffected. The SPA maps this code to *"the assistant is
 * unavailable — you can still create this campaign in the wizard"* plus the link.
 */
export class LlmUnavailableError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(AGENT_ERROR_CODE.AGENT_LLM_UNAVAILABLE, 503, options);
  }
}

/** 409 — a message, plan or confirm sent to a session that is no longer collecting. */
export class SessionNotActiveError extends AppError {
  constructor(state: string, options: AppErrorOptions = {}) {
    super(AGENT_ERROR_CODE.AGENT_SESSION_NOT_ACTIVE, 409, {
      ...options,
      logContext: { ...options.logContext, state },
    });
  }
}

/** 409 — the runaway guard fired. The maker is pointed at the wizard. */
export class SessionExhaustedError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super(AGENT_ERROR_CODE.AGENT_SESSION_EXHAUSTED, 409, options);
  }
}
