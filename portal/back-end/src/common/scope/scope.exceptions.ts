/**
 * T-013 — the HTTP failure a scope violation is allowed to look like.
 *
 * There is exactly one, and it is a **404**.
 *
 * 02-SECURITY.md §5.1 is unambiguous: *"A cross-tenant id returns 404, not 403 — a 403 confirms
 * the record exists."* That single sentence is why this file has one class and not two. There is
 * deliberately no `ScopeForbiddenException` to reach for: an agent building a Wave 3 endpoint
 * cannot accidentally pick the wrong one, because the wrong one does not exist.
 *
 * The body carries a catalogue key and nothing else — no resource name, no id, no reason
 * (T-013 TC-3). The same envelope shape `auth.exceptions.ts` produces, for the same reason: the
 * SPA localises `code` through `system_messages`, so an internal detail never has a route to a
 * browser. T-014's `ErrorNormalisationFilter` will recognise this as an `HttpException` already
 * carrying a well-formed body and add only `message`/`traceId`.
 *
 * ### Why this is not in `common/errors/`
 *
 * `src/common/errors/` is T-014's to create, and T-014 has not started. Duplicating a two-line
 * envelope here — rather than pre-empting a file another task owns — is the smaller cost.
 * T-014 folds this into the shared catalogue; the class name and the wire shape do not change
 * when it does. Recorded as a deviation in the T-013 completion report.
 */
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The catalogue key, shared with `AUTH_ERROR_CODE.NOT_FOUND` so that T-011's `DELETE
 * /auth/sessions/:id` and every Wave 3 lookup answer with the same code.
 *
 * ### Why not the seeded `SCOPE_VIOLATION` key
 *
 * T004_004 seeds a `SCOPE_VIOLATION` message whose text is *"The requested resource could not be
 * found."* Using it here would be a mistake, and a subtle one: 03-API-CONTRACT.md §1's status
 * table requires 404 to mean *"not found **or** out of scope — deliberately indistinguishable"*.
 * A distinct `SCOPE_VIOLATION` code makes them distinguishable again — the client can read the
 * code even though the prose is identical — which is precisely the existence oracle 02-SECURITY.md
 * §5.1 forbids. One code for both causes is the whole point.
 *
 * `NOT_FOUND` currently has **no `system_messages` row** (T004_004 seeded `SCOPE_VIOLATION`
 * instead). That is a real gap in the catalogue, not in this file: the SPA cannot localise a key
 * that does not exist. Flagged in the T-013 completion report and picked up by T-014, which owns
 * `src/common/messages/`.
 */
export const SCOPE_ERROR_CODE = {
  NOT_FOUND: 'NOT_FOUND',
} as const;

/**
 * 404 for a row that either does not exist or is outside the caller's scope.
 *
 * Constructed with no arguments, like `InvalidCredentialsHttpException`, so that a caller
 * *cannot* attach a discriminator even by accident. The distinction between the two causes is
 * exactly what must not reach the client.
 */
export class ScopeViolationError extends HttpException {
  constructor() {
    super({ error: { code: SCOPE_ERROR_CODE.NOT_FOUND } }, HttpStatus.NOT_FOUND);
  }
}
