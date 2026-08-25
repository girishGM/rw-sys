/**
 * T-037 implementation note 2 — the `ActorRef` helper, and gap G5.
 *
 * > *"`tenant_campaigns.created_by` is `varchar(100)` while `approval_requests.requested_by` is
 * > `int` (gap G5). Use the shared `ActorRef` helper — `String(user.id)` for varchar columns,
 * > `user.id` for int columns. **Improvising per call site makes the audit trail unjoinable.**"*
 *
 * The note asks for a *shared* helper. None existed when this task started (`grep -rn ActorRef
 * back-end/src` found exactly one hit: a prose mention in `tenant-campaign.model.ts`'s own doc
 * comment), so it is created here, in the first module that needs it. Deliberately **not**
 * placed in `common/` — that directory belongs to the Wave 1 tasks and R9 keeps this task out of
 * it; when T-038/T-047/T-048 need the same two functions they import them from here, and if a
 * later task moves the file to `common/` that is a one-line change with no behavioural risk.
 *
 * ### Why two functions and not one
 *
 * Because the whole bug class this exists to prevent is *using the wrong one*. A single
 * `actorRef(user)` returning `string | number` would push the choice back to the call site — the
 * exact improvisation the note forbids — and `String(7)` versus `7` is precisely the difference
 * that turns `JOIN ... ON audit.performed_by = campaign.created_by` into an empty result set
 * six months later, with no error anywhere.
 *
 * The functions are trivial. That is the point: they are named after the **column type** they
 * feed, so a reviewer reading `createdBy: actorRefText(actor)` next to `varchar(100)` can see
 * the pairing is right without knowing anything else about the schema.
 */
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';

/** The minimum an actor must look like. Satisfied by `AuthenticatedUser`. */
export interface IdentifiedActor {
  readonly userId: number;
}

/**
 * The actor as a **`varchar`** column expects it — `tenant_campaigns.created_by` /
 * `approved_by`, both `varchar(100)`.
 *
 * Plain decimal, no prefix, no padding: the value has to stay `::int`-castable so a future
 * reconciliation query can join it against the integer columns without a parsing rule that only
 * exists in someone's head.
 */
export function actorRefText(actor: IdentifiedActor): string {
  return String(actor.userId);
}

/**
 * The actor as an **`int`** column expects it — `portal_approval_requests.requested_by`,
 * `portal_campaign_audit_trail.performed_by`.
 *
 * Both of those are `reward_portal` tables with a real `portal_users(id)` foreign key (T037_001 /
 * T037_002), so this value is checked by the database rather than merely intended. Their
 * `reward_config` counterparts reference `admin_users` and could not hold it at all — see those
 * migrations' headers.
 */
export function actorRefId(actor: IdentifiedActor): number {
  return actor.userId;
}

/** Parses a `varchar` actor reference back to the integer id, or `null` when the column holds
 * something this helper did not write (legacy rows from the `create-campaign` agents, which
 * predate the portal and are free text). Used only for display joins, never for authorisation. */
export function parseActorRefText(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

/** Convenience for the common case: both forms of the same actor. */
export function actorRefs(actor: AuthenticatedUser): { text: string; id: number } {
  return { text: actorRefText(actor), id: actorRefId(actor) };
}
