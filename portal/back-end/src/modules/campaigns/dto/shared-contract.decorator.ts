/**
 * T-037 — `@MatchesSharedContract(schema)`, the bridge between `class-validator` (which the
 * global `ValidationPipe` runs) and the Zod schemas in `packages/shared` (which are the actual
 * wire contract, shared with the SPA).
 *
 * ### The problem this solves
 *
 * `class-validator` decorators are **per property**. Most of this task's DTOs have at least one
 * rule that spans two of them, and every one of those rules is already written, once, in
 * `campaign.schema.ts`:
 *
 *  - `endDate > startDate` and `startDate >= today` (TC-8/TC-9/TC-10);
 *  - `budgetCurrency` required whenever `budgetAmount` is set (TC-11);
 *  - `completionThreshold` required for `n_of`;
 *  - every one of `campaignCapInputSchema`'s six refinements, each mirroring a live database
 *    CHECK (TC-21w and friends).
 *
 * Re-expressing those in `class-validator` would be a second implementation of the contract the
 * SPA validates against — and 00-ARCHITECTURE.md §8's whole reason for `packages/shared` is that
 * *"identical client and server validation"* comes from one definition, not two that agree today.
 *
 * ### How it works, and why it is safe
 *
 * `class-validator` hands every constraint the whole object under validation as
 * `args.object`. So the constraint below ignores the property it is attached to and parses the
 * **DTO itself** against the shared schema. The property it decorates is arbitrary; by
 * convention it is attached to the first field the cross-field rule concerns, so the resulting
 * `details` entry points somewhere useful.
 *
 * Two properties make this trustworthy rather than clever:
 *
 *  - **It only ever adds failures.** The per-property decorators still run and still fail
 *    independently, so this cannot loosen anything — a DTO that passes Zod but fails
 *    `@IsInt()` is still a 400.
 *  - **The server parses the same bytes the client did.** That is the point of TC-17
 *    (*"parameter value violating the rule's `min` → 400, **server-side**, with client
 *    validation bypassed"*) generalised: a `curl` that skips the SPA meets the identical schema.
 *
 * `undefined`-valued keys are stripped before parsing. A `class-transformer`-built instance can
 * carry `{ description: undefined }` for an absent optional field, and while Zod treats that as
 * absent for `.optional()`, it does **not** for a `.strict()` object's unknown-key check in every
 * version — stripping removes the ambiguity rather than depending on it.
 *
 * ### The one rule for attaching this: never to a property that also carries `@IsOptional()`
 *
 * `@IsOptional()` registers a `CONDITIONAL_VALIDATION` on its property, and `class-validator`
 * short-circuits **every** validator on a property whose condition is false. So a contract
 * decorator sitting next to `@IsOptional()` silently stops running the moment that field is
 * omitted — which, on an all-optional `PATCH` DTO, is most of the time. It fails open, and it
 * fails open exactly where the cross-field rules matter (a `PATCH` that moves `endDate` before
 * `startDate` supplies neither `name` nor anything else the decorator might have been attached
 * to). Caught by `dto.spec.ts`'s *"still enforces the date ordering when both are supplied"*
 * case while building this task, not reasoned about in advance.
 *
 * The convention this module follows, therefore: attach `@MatchesSharedContract` to the DTO's
 * first declared property and give that property **no** other decorators when it is optional —
 * its own field-level rules are then expressed once, in the shared Zod schema, which is where
 * every other cross-field rule already lives. `CreateCampaignDto.campaignCode` and friends are
 * required properties, so they keep their per-field decorators as well.
 */
import {
  ValidationOptions,
  ValidatorConstraint,
  registerDecorator,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import type { ZodTypeAny } from 'zod';

@ValidatorConstraint({ name: 'matchesSharedContract', async: false })
export class MatchesSharedContractConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const [schema] = args.constraints as [ZodTypeAny];
    return schema.safeParse(withoutUndefined(args.object)).success;
  }

  defaultMessage(args: ValidationArguments): string {
    const [schema] = args.constraints as [ZodTypeAny];
    const result = schema.safeParse(withoutUndefined(args.object));
    if (result.success) return 'does not match the shared wire contract';
    // Zod's own message, for the **server log** only. `ErrorNormalizationFilter` never copies a
    // validator message into a response body — the client receives the derived
    // `MATCHES_SHARED_CONTRACT` detail code and the catalogue's text for it
    // (`app-error.ts`: "Nothing a client receives is derived from the text of an error").
    return result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
  }
}

/**
 * Validates the **whole DTO** against `schema`. Fails with detail code
 * `MATCHES_SHARED_CONTRACT`, which `validation.exception-factory.ts` derives mechanically from
 * this constraint's registered name.
 */
export function MatchesSharedContract(schema: ZodTypeAny, options?: ValidationOptions) {
  return function decorate(object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [schema],
      validator: MatchesSharedContractConstraint,
    });
  };
}

/** A shallow copy of `value` with every `undefined`-valued own key removed. */
function withoutUndefined(value: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}
