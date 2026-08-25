/**
 * T-048 — the confirmation gate (10-AI-CAMPAIGN-AGENT.md §3.2).
 *
 * ```
 * Zone 2 assembles the complete plan
 *   → canonical JSON → sha256 → plan_hash
 *   → renders a plain-language summary + a structured review panel
 *   → maker clicks "Create this campaign"  (the hash is submitted with the click)
 *   → Zone 2 recomputes the hash from the stored plan; mismatch ⇒ REJECT
 * ```
 *
 * Ported from `agents/create-campaign-v2/src/tools/plan-hash.ts`, whose canonicalisation is
 * correct and is kept verbatim in spirit: object keys sorted recursively, array order preserved
 * (order is semantically meaningful — component 1 then component 2 is a different journey from the
 * reverse).
 *
 * ### The one change from the ported original, and why it is the important one
 *
 * The standalone agent hashed *the stored plan*. This one recomputes the plan **from the stored
 * slots** before hashing (see `plan.tool.ts`), so the comparison at confirm time is not "does the
 * hash match the plan we saved" — which a later turn could have rewritten along with the plan —
 * but "does the hash match what the current answers would build". That is what makes TC-15
 * (*"plan mutated between display and confirm"*) fail closed no matter which half was mutated:
 * change a slot and the recomputed plan differs; change the stored plan and it is not what gets
 * executed anyway, because execution reads the recomputed one.
 *
 * ### Why the comparison is constant-time
 *
 * A plan hash is not a secret and this is not a MITM defence — an attacker who can call `confirm`
 * can also call `plan` and read the hash. It is `timingSafeEqual` because the cost is one function
 * call and the alternative is a reviewer having to work out whether it matters here; using the
 * safe comparison uniformly for every hash in the system is cheaper than reasoning about each one.
 */
import { Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

@Injectable()
export class PlanHashService {
  /**
   * Deterministic, order-independent JSON: object keys sorted recursively, arrays left in order.
   *
   * `undefined` is dropped exactly as `JSON.stringify` drops it, which is why the plan schema uses
   * `null` rather than optional fields throughout — an optional field that is sometimes absent and
   * sometimes `null` would hash to two different values for one plan.
   */
  canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeys(value));
  }

  /** sha256 of the canonical form, lower-case hex. */
  hash(plan: unknown): string {
    return createHash('sha256').update(this.canonicalJson(plan)).digest('hex');
  }

  /**
   * Whether `submitted` is the hash of `plan`.
   *
   * A malformed `submitted` (wrong length, non-hex) returns `false` rather than throwing:
   * `confirmAgentPlanRequestSchema` has already rejected those shapes at the DTO layer, so
   * reaching here with one means something is wrong that a 409 "the plan changed" describes as
   * well as anything else — and better than a 500.
   */
  matches(plan: unknown, submitted: string): boolean {
    const expected = Buffer.from(this.hash(plan), 'utf8');
    const actual = Buffer.from(submitted, 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
