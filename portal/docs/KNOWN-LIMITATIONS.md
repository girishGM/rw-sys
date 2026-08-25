# Known Limitations

**Owner:** T-054 (`agent-qa`). This document exists to be honest, not reassuring — every item
below was either specified as a deliberate v1 boundary by the architect (`BACKLOG.md`,
`00-ARCHITECTURE.md`) or found live, against the running system, while writing this document
or an earlier task's own completion report. Nothing here has been softened to make the release
look more finished than it is. Where a limitation is a genuine **defect** rather than a
deliberate boundary, it is filed as its own task (`T-0xx`) and linked below — check
`project-plan/progress.json` for its current status before relying on the summary here.

---

## 1. Two identity tables exist — `admin_users` and `portal_users`

`reward_config.admin_users` still cannot store `maker`/`checker` (its `role` CHECK constraint
only permits `super_admin, country_admin, tenant_admin, merchant` — gap G1,
`00-ARCHITECTURE.md` §3.2) and has no credential column at all (gap G2). The portal's real
identity table is the new `reward_portal.portal_users`, which supports all six roles and owns
its own Argon2id credentials, sessions and refresh tokens.

**Consequence:** `admin_users` is left completely untouched and unused by the portal.
**Anything outside the portal that reads `admin_users` expecting to see portal users — a
report, a BI extract, another internal service — will see none of them.** The two tables are
not synchronised in either direction, and nothing in this codebase attempts to keep them in
step. If a downstream consumer of `admin_users` exists today, its owners need to be told this
explicitly before go-live, not discover it later. This is not something T-054 or any other
portal task can close by itself — closing it would mean either migrating `admin_users`
(forbidden by C1/C2, `00-ARCHITECTURE.md` §2) or building a two-way sync neither the design nor
any task file describes. Flagged here as a decision for the product/data owners, not silently
worked around.

## 2. Inconsistent actor typing between `tenant_campaigns` and `approval_requests`

`tenant_campaigns.created_by`/`approved_by` are `varchar(100)`; `approval_requests.requested_by`
is `int` (gap G5). The portal papers over this with one helper,
`back-end/src/modules/campaigns/actor-ref.ts` (`actorRefId`/`actorRefText`) — every write goes
through it, and it is the **only** place permitted to decide which representation a given column
gets. A join across the two tables (or a hand-written report/migration touching both) must go
through the same helper's logic, not guess. This is a real, permanent shape of the schema, not
a bug this portal can fix without an out-of-scope, non-additive migration on `tenant_campaigns`
(forbidden by C1) — it is recorded here so nobody rediscovers it by getting a join silently
wrong.

## 3. MFA is modelled but not implemented for five of six roles

`portal_users.mfa_enabled`/`mfa_secret_enc` and `portal_mfa_recovery_codes` exist and are fully
wired for exactly **one** role: `super_admin`, where it is mandatory (T-055, architect review
AR-08 — a compromised `super_admin` credential has unbounded blast radius, §5.2a of
`00-ARCHITECTURE.md`). `country_admin`, `tenant_admin`, `maker`, `checker` and `merchant` all
have the column and the table available to them structurally, but **no enrolment screen, no
challenge screen, and no enforcement guard exists for any of the other five roles.** A
`country_admin` account — which can onboard every tenant in a country — is protected by
password and lockout alone. This was a deliberate, disclosed v1 scope decision
(`BACKLOG.md` B-02: "mandatory for `super_admin` ... before making it optional elsewhere"), not
an oversight, but it is a real gap a security-conscious customer will ask about, and the answer
is "not yet," not "already covered."

## 4. `portal_user_roles` exists but is unused

The schema has a `reward_portal.portal_user_roles` table (future-proofing for a user holding
more than one role at a time — `00-ARCHITECTURE.md` §4). In v1, every user holds exactly **one**
role, stored directly on `portal_users.role`, and nothing reads or writes
`portal_user_roles`. It is empty in every environment, including production, by design.

## 5. Email delivery is stubbed unless SMTP is configured

Password reset links, activation notices and the temporary-password flow do not send real email
in this codebase unless a real SMTP relay is configured out of band (nothing in this repo stands
one up). In every environment this project has tested against, `POST /users` and
`POST /auth/forgot-password` return the credential/link **directly in the API response**,
revealed once, on screen (`docs/screenshots/08-temporary-password-reveal.png`), and the person
creating the account is trusted to hand it to the new user out of band (T-046,
"one-time password reveal — no email in v1"). This is workable for the pilot's onboarding
volume; it does not scale to self-service password reset at real user counts, and there is no
delivery-failure/retry story because there is no delivery. Wiring a real SMTP/transactional-email
provider is out-of-scope backlog work (`BACKLOG.md`), not a defect — but do not assume "forgot
password" reaches an inbox anywhere this has been tested.

## 6. Global rules/rewards rely on `tenant_id IS NULL` — **flag this to other services' owners**

A Super-Admin-authored, country-wide rule or reward is stored with `tenant_id = NULL`
(constraint C4, enabled by the two authorised `DROP NOT NULL` migrations, gap G6). Country
visibility for these rows is resolved entirely through **version assignment**
(`06-VERSIONING.md`), not through `tenant_id`. **Any other service that queries
`reward_config.rule_master`/`reward_config.reward_systems` with a literal
`WHERE tenant_id = :id` will silently miss every global rule and reward** — the row is real,
active, and assigned to that tenant's country, but a naive tenant-scoped query will never
surface it. This is the one change in this project with a blast radius outside the portal
(`00-ARCHITECTURE.md` §3.2, gap G6) and the `create-campaign`/`create-campaign-v2` agents in
this repository — or any other consumer of `reward_config` — need to be told this explicitly
before this schema change reaches them. This is not hypothetical: it is exactly the shape of
gap this document exists to surface loudly rather than let a downstream team discover in
production.

## 7. Reward assignment to campaign steps required actor-supplied data to be built correctly by hand once — a real usability trap

The campaign wizard's rewards step (`docs/screenshots/42-campaign-wizard-rewards.png`) lets a
maker attach a reward at three levels (campaign, tracker, step) independently, each with its
own "Add a reward" control. It is easy — and was hit live while writing this document's own
`USER-GUIDE.md` walkthrough — to click "Attach" and immediately move to the next wizard step
before the attach request's response has been observed by the UI; nothing in the wizard blocks
"Next" on an in-flight mutation for this step. The attach itself is not lost (it is a normal,
awaited server write), but a maker who clicks fast enough can leave the review screen showing a
stale state for a moment. Not a data-integrity bug — the underlying `POST
/campaigns/:id/rewards` call and its 201 response are real and correct — but a rough edge worth
a UX pass post-v1.

## 8. `POST /users` returned the new user's email as raw ciphertext — found live, now fixed and re-verified (T-101)

Found live, by an independent reviewer of this task, running `docs/UAT-SCRIPT.md` Section 1–3
end to end against the real `docker-compose.yml` stack with fresh `super_admin`/`country_admin`/
`tenant_admin` accounts — not by any prior automated suite. **`POST /users`
(`back-end/src/modules/users/users.service.ts#create`, T-035) returns `portal_users.email` in its
response body as the raw ciphertext** (`v1.field_20260823...`), not the plaintext address the
admin just typed — confirmed 3x live for maker, checker and merchant creation alike.

**Root cause, confirmed by reading the code, not just observing the symptom:** `PortalUser.email`
is only decrypted by an `afterFind` model hook. `create()` built its response DTO
(`toUserCreatedResponseDto`) directly from the instance `this.scoped.create()` returned after
`INSERT` — a hook `afterFind` never fires for. `GET /users/:id` and
`POST /users/:id/reset-password` were **not** affected: both explicitly reload the row via
`findByPkOrFail` (which does trigger `afterFind`) before building their own response DTO.
`countries.service.ts#provisionCountryAdmin` and `tenants.service.ts` were also **not** affected —
both build their response from `dto.email.trim()` (the plaintext request input), never from the
model instance, which is exactly why `docs/screenshots/08-temporary-password-reveal.png` (a
Country Admin provisioned via `POST /countries/:id/admins`) looked correct throughout, while the
equivalent maker/checker/merchant-creation screenshots conspicuously had no matching capture at
the time this section was first written.

**User-facing impact while open — this was not cosmetic.** `front-end/src/features/users/AddUserModal.tsx`
(~line 196) renders this response's `email` directly via `PasswordRevealPanel` ("Account created
for `{result.email}`"). A real admin creating a maker, checker or merchant would have seen a
garbled ciphertext string on the exact screen `docs/UAT-SCRIPT.md` Section 3 steps 5–7 depend on
("note the Maker's email and password") — the one screen in the entire golden journey whose only
job is to hand a working credential to a new user. There was no workaround inside the product:
the temporary password shown alongside it was always correct and usable, but the admin could not
have read who it was issued to from this screen.

**Status: fixed and independently re-verified (updated 2026-08-24, this document's fourth
revision).** Filed as `T-101` per `AGENT-PROTOCOL.md` §7.1 (the affected file,
`back-end/src/modules/users/users.service.ts`, was out of this task's file scope —
T-035/`agent-feature-tenancy` owns it, not `agent-qa`). `T-101`'s fix: `create()` now reloads the
row via `this.scoped.findByPkOrFail(PortalUser, created.id, { transaction })` before building its
response DTO — the same pattern `resetPassword()`/`update()`/`deactivate()` already used in this
file, and the same remedy the evidence filed by this task suggested.

**Re-verified independently for this document, not taken on `T-101`'s own report alone:**

1. `back-end/test/users/users.e2e-spec.ts` (T-101's new suite) re-run against the real local
   Postgres, real `AppModule`, real encryption hooks (no mocks) for this revision: 2/2 passing —
   the HTTP response carries the typed plaintext address, and a raw `SELECT` against
   `reward_portal.portal_users` in the same test independently confirms the *stored* row is still
   genuine ciphertext (the fix decrypts the response; it does not change how the column is
   persisted). The suite also proves the regression case (fails on the unfixed code): reverting
   the fix reproduces the exact ciphertext envelope reported above, `v1.dev_local_fld....`, before
   the fix is restored.
2. The `docker-compose.yml` stack (`api`, `web`) was rebuilt (`docker compose build api web`) and
   recreated (`docker compose up -d --no-deps api web`) against current source for this revision —
   the same "fix landed vs. fix deployed" gap §9 already flags for T-092 applies equally here, and
   was checked rather than assumed; both containers report healthy against current source.

This is the same discipline `project-plan/reports/T-054-release-readiness.md` §1 required before
flipping T-091/T-092 from NO-GO to GO on this task's second pass, applied identically here rather
than taking `T-101`'s `done` status in `project-plan/progress.json` at face value. See that
report's §1 for the resulting go/no-go call — this item is no longer what that call turns on.

## 9. Three live defects found while producing this task's own material — all now fixed and re-verified live

Writing `USER-GUIDE.md`'s screenshots, and independently re-running `docs/UAT-SCRIPT.md` itself,
meant walking the golden journey by hand, in a real browser, against the real docker-compose
stack (`docker-compose.yml`) — not against mocked data. Three release-blocking defects surfaced
this way that no prior task's own automated suite caught, each filed as its own task per
`AGENT-PROTOCOL.md` §7.1 (T-054 could not fix any of them directly — all three were outside
`docs/**`/`e2e/**` — but all three have since landed, `done`, and this document's own
re-verification passes (last: 2026-08-24) confirmed each fix live, not just in `progress.json`):

- **T-091 — `reward_app` had no `GRANT` on ~19 `reward_config` tables added after
  `T002_008_grants.ts` was written**, including `tracker_components`,
  `tracker_tracker_components`, every versioning table (`rule_versions`, `reward_versions`,
  `version_blasts`, ...), `campaign_caps`, `tenant_budget_ceilings`, `definition_requests` and
  `activities`. On a fully migrated, fresh database, **the campaign wizard's own Journey step —
  part of the mandatory golden journey — 500d the moment a tracker was created**, with a raw
  Postgres `permission denied for table tracker_tracker_components`. **Fixed** by
  `T091_001_grant_versioning_and_budget_tables.ts`. Re-verified live for this document: on the
  current, fully migrated local database, `test/database/portal-schema.e2e-spec.ts`'s TC-2/TC-3
  ("`reward_app` can now SELECT/INSERT/UPDATE all 19 previously-ungranted `reward_config`
  tables") and `test/database/tracker-composition.e2e-spec.ts` (12/12) both pass against the
  real Postgres instance, not a mock.
- **T-092 — `GET /dashboard/widgets/:widgetKey` did not exist anywhere in the back end.**
  Every dashboard widget, for every one of the six roles, rendered its error tile. **Fixed** —
  the route and a resolver per `widget_key` now exist
  (`back-end/src/modules/dashboard/**`). Re-verified live for this document two ways: (1)
  `test/dashboard/dashboard.e2e-spec.ts` (9/9) against the real local Postgres, and (2) by hand,
  in a real browser, against the actual `docker-compose.yml` stack — **the docker images
  running at the time this document was first drafted (2026-08-24, early) predated T-092's own
  fix landing, so the deployed containers still showed the broken tiles even after T-092's own
  task report said "done"; rebuilding `api`/`web` (`docker compose build api web && docker
  compose up -d --no-deps api web`) against the current source picked up the fix immediately.**
  That gap — a real fix, correctly reviewed, sitting un-deployed in a long-lived local
  environment — is itself worth naming explicitly: **`docs/RUNBOOK.md`/`docs/DEPLOYMENT.md`'s
  redeploy step is not optional after a hardening-wave fix lands; a stale container will keep
  showing the old bug indefinitely with no error of its own.** All six roles' dashboards were
  captured fresh after the rebuild and now show real data
  (`docs/screenshots/05-super-admin-dashboard.png`, `21-country-admin-dashboard.png`,
  `26-tenant-admin-dashboard.png`, `35-maker-dashboard.png`, `46-checker-dashboard.png`,
  `51-merchant-dashboard.png` — each overwrites the earlier, broken-tile capture of the same
  screen; the before/after was directly observed while producing this document, not asserted).
- **T-101 — `POST /users` returned the new user's `email` as raw ciphertext, not plaintext**,
  found by an independent reviewer running `docs/UAT-SCRIPT.md` Section 1–3 live. **Fixed** —
  `create()` now reloads the row before building its response DTO, matching the pattern already
  used elsewhere in the same file. Full detail, including the independent re-verification
  evidence, is in §8 above rather than duplicated here.

All three were **critical severity** (T-101: High per its own task file) and are the reason
`project-plan/reports/T-054-release-readiness.md` moved between NO-GO and GO more than once while
this task was in progress. With all three closed and independently re-verified live (not just
trusted from their own completion reports), see that report's §1 for the current, final
recommendation.

## 10. This document itself cannot be kept current automatically

Everything above is accurate as of 2026-08-24 (re-checked a fourth time, later the same day, after
T-101 — the third live defect this document's own production surfaced — reached `done` and was
independently re-verified against the real running system, not against T-101's own report or
`progress.json` alone). If a later task changes any of the above (adds MFA for another role,
wires real email, or introduces a new gap), **this file needs a human or agent to update it
deliberately** — nothing regenerates it. Treat a stale limitations doc as worse than none: check
`project-plan/progress.json` for the current status of any item above before relying on it.
