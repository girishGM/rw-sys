/**
 * T-046 — the one-time credential response: `POST /users` and `POST /users/:id/reset-password`
 * (BACKLOG.md B-01). Moved out of `./user-response.dto.ts`, where T-035 first shipped it (that
 * file's own header, and `users.service.ts`'s header, explain why `POST /users` returns a
 * generated password at all despite 03-API-CONTRACT.md §7's original text saying otherwise).
 *
 * `temporaryPassword` is the plaintext, deliberately: generated once by
 * `TemporaryPasswordService`, returned once, never stored anywhere this DTO — or anything else —
 * could later read it back from. Its `data_protection_policies` row
 * (`dto.CreateUserResponse.temporaryPassword`, seeded by `T017_002`, plus this task's own
 * `dto.ResetPasswordResponse.temporaryPassword` in `T046_001`) is `log_treatment: omit`,
 * `classification: secret`, `ui_visibility: plain` — omitted from every log line, shown as-is in
 * this one response. Implementation note 4's literal `reveal_on_demand` text is superseded by
 * that already-seeded, already-`done` row: `GET /reveal/:policyKey/:recordId` (T-017) discloses a
 * *stored* column value, and this field is never stored, so there is no record for that endpoint
 * to look up. Flagged for the reviewer per AGENT-PROTOCOL §3, the same "design doc wins, and here
 * the more specific/more recent one is the already-shipped policy row" reasoning
 * `users.service.ts`'s own header applies to this task's `pending_activation`/password-field
 * text.
 *
 * `passwordExpiresAt` is intentionally **not** part of this DTO. 72-hour expiry
 * (`TemporaryPasswordService`, `TEMPORARY_PASSWORD_TTL_MS`) is enforced and auditable entirely
 * server-side; no test case or implementation note in T-046's own task file asks the wire
 * contract to carry it, and the panel's warning text is static ("… within 72 hours"), not a
 * countdown against a returned timestamp. Adding a field nothing reads would only be a second
 * place for the two ends of the contract to drift.
 *
 * ### `config/data-protection.json`'s `routeOverrides` cannot literally cover the reset route —
 * escalated, not silently worked around
 *
 * Implementation note 3 asks for `full` transport encryption via `routeOverrides` on **both**
 * `POST /users` and `POST /users/:id/reset-password`. Only the first is possible with the
 * mechanism T-018 already shipped: `TransportPolicyService.modeFor()` builds its lookup key from
 * `request.path` — the real, resolved URL (`normalisePath`, `back-end/src/common/transport-crypto/
 * transport-crypto.constants.ts`, outside this task's file scope) — with no path-parameter
 * normalisation at all, so a config entry can only ever match a literal, paramater-free path.
 * `POST /users` qualifies; `POST /users/:id/reset-password` structurally cannot; a config line
 * naming it would sit in the file matching nothing, which is worse than not writing it — a
 * reviewer reading `config/data-protection.json` would reasonably believe the reset route got the
 * same whole-body envelope the create route does, and it would not. No such line is added here.
 *
 * This does **not** leave `temporaryPassword` unencrypted on the reset route. Both policy rows
 * this file's own header names carry `in_transit: payload_encrypt`, and `PayloadEncryptInterceptor`
 * applies that **per field**, by name, in the global default `fields` mode — independently of any
 * route override (`isPayloadEncryptField`). The reset route therefore still encrypts
 * `temporaryPassword` itself; what it does not get is the *whole-body* opacity `full` mode adds on
 * top (every other field in the envelope travelling in the clear rather than as one blob). That
 * gap — a parameterised route can never appear in `routeOverrides` at all — is a T-018 limitation,
 * `back-end/src/common/transport-crypto/**`, outside this task's file scope (AGENT-PROTOCOL R9);
 * flagged for the architect (§7) rather than fixed here, and restated in the completion report.
 */
import type { PortalUser } from '@/database/portal-models';
import { toUserDto, type UserDto } from './user-response.dto';

export interface UserCreatedResponseDto extends UserDto {
  readonly temporaryPassword: string;
}

export function toUserCreatedResponseDto(
  user: PortalUser,
  temporaryPassword: string,
): UserCreatedResponseDto {
  return { ...toUserDto(user), temporaryPassword };
}
