# Customer Reward Dashboard (test-app)

A standalone demo app showing what a **customer** (not the portal admin) sees: a reward
dashboard with running campaigns, rewards earned across types (cashback / promo code / Stripe
points), progress trackers, and an Activity Simulator that fires a fake customer activity and
watches it flow into a new reward, live via Server-Sent Events.

It's built against **real campaign/tracker configuration** read from `portal/back-end` (the
NestJS admin portal that lives elsewhere in this repo), combined with an **in-memory
reward-tracking stand-in** (`tracking-service`) that invents the customer-progress and
reward-ledger data no real service in this repo owns yet. See
[`../test-app-plan/ARCHITECTURE.md`](../test-app-plan/ARCHITECTURE.md) for the full design —
this README won't re-explain it, just get you running.

## Prerequisites

1. **Node 20** on `PATH` (both `package.json`s pin `engines.node: ">=20 <21"`). The repo-wide
   shell default is often an older version — see the root `CLAUDE.md`'s "Local environment"
   section:
   ```bash
   export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
   ```
2. **A real, running, migrated `portal/back-end`.** `tracking-service` is a real REST client of
   it — there is no offline/mocked mode. From `portal/`:
   ```bash
   npm run db:migrate        # from portal/back-end, if not already migrated
   cd portal/back-end && PORT=3001 npx nest start --watch
   ```
   (`PORT=3001` is a deliberate override — `portal/front-end`'s own dev proxy and this app's
   `tracking-service` both expect the back-end on `3001`, but `back-end/.env.development`'s own
   default is `3000`. This is a known, pre-existing mismatch in `portal/`, not something to fix
   here.) Confirm it's up: `curl http://localhost:3001/api/v1/health` → `{"status":"ok"}`.
3. **A seeded portal account for `tracking-service` to log in as.** `tracking-service` logs into
   `portal/back-end` itself (it's the one piece of real data this app has) as a `tenant_admin`
   account — merchant-role is deliberately *not* used; see
   [`../test-app-plan/tasks/T-003-portal-client-and-data-model.md`](../test-app-plan/tasks/T-003-portal-client-and-data-model.md)'s
   Implementation notes for why (a merchant session is denied read access to tracker/component
   structure by the portal's own scope strategy). No such account ships with the repo's seed data
   — if one doesn't already exist in your local Postgres, create one through
   `portal/back-end`'s own Tenant Admin onboarding flow (Country Admin → "Add tenant admin" in the
   portal UI, or the equivalent `POST /tenants` call) and note its email/password for step 2 below.
4. `test-app/tracking-service/.env` (git-ignored — never commit real values into
   `.env.example`). Copy the example and fill it in:
   ```bash
   cd test-app/tracking-service
   cp .env.example .env
   ```
   Then set, at minimum:
   ```
   PORT=4001
   PORTAL_BASE_URL=http://localhost:3001
   PORTAL_LOGIN_EMAIL=<the tenant_admin account from step 3>
   PORTAL_LOGIN_PASSWORD=<its password>
   ```
   `PORTAL_CACHE_TTL_MS` is optional (defaults to 5 minutes).

## Setup

From `test-app/` (this directory's own npm workspace root — a sibling of `portal/`, not nested
inside it):

```bash
npm install
```

This installs both `frontend` and `tracking-service` in one pass (npm workspaces).

## Run

```bash
npm run dev
```

This starts both packages concurrently:

- `tracking-service` on **http://localhost:4001** — logs into `portal/back-end` on boot, pulls
  real campaign/tracker/tracker-component data, and serves the REST + SSE API.
- `frontend` on **http://localhost:5174** — a Vite dev server whose `/api/*` calls proxy to
  `tracking-service` (see `frontend/vite.config.ts`).

Open **http://localhost:5174**. If `tracking-service` can't reach `portal/back-end` or the
login fails, it fails loudly in its own terminal output (no silent empty-data fallback) — check
there first if the dashboard looks empty or errors.

## Golden path — what to try

A short tour that exercises every major piece: real portal data, live in-memory
progress/reward state, theming, and the SSE push.

1. **Open the dashboard** (`/`). You'll see a default customer (Priya Shah) with active
   campaigns pulled from the real portal, a compact progress widget per tracker, and any rewards
   already earned in the seeded demo state.
2. **Switch theme** using the 3 swatches in the header (Bright / Midnight / Celebration) — no
   reload, pure CSS re-theme.
3. **Switch customer** using the profile chip in the header (Priya Shah / Marcus Tan / Aisha
   Rahman) — this re-fetches that customer's own progress/rewards from `tracking-service`.
4. **Go to Activity Simulator** (`/activity`). With **Marcus Tan** selected, submit two
   activities of type **"Weekend Transaction"** in a row (merchant/amount are optional). The
   first completes one of the two "Weekend Challenge" tracker components; the second completes
   the tracker itself.
5. **Watch it update live**: the Activity Simulator's own feed shows "Progress updated" after
   the first submit and "Reward earned" (with a toast) after the second — pushed over the SSE
   connection, no page reload. Switching to the **Dashboard** or **My Rewards** tab confirms the
   same state: "Weekend Challenge" now shows 2/2 with "Reward unlocked!", and My Rewards lists a
   new, unused Promo Code reward under the Weekend Promo Blitz campaign.

Any other customer/activity-type pair works the same way — this one is called out because it
reaches "reward earned" in exactly two submissions, from a fresh `tracking-service` process. A
matching `activityType` for a tracker component already at 100% is a no-op (nothing left to
complete).

## Other useful commands (from `test-app/`)

```bash
npm run typecheck --workspaces --if-present
npm run lint --workspaces --if-present -- --max-warnings=0
npm test --workspaces --if-present
npm run build --workspaces --if-present
```

## What this app is not

- Not a persistence layer — every customer's progress and reward ledger lives in
  `tracking-service`'s memory and resets when it restarts. Only campaign/tracker *configuration*
  is real and durable (it lives in `portal/back-end`'s own Postgres).
- Not a second way to administer campaigns — this is the read-only, customer-facing side; all
  editing happens in `portal/front-end`.

See [`../test-app-plan/ARCHITECTURE.md`](../test-app-plan/ARCHITECTURE.md) for the rest of the
design (tech stack, page-by-page breakdown, visual system), or [`DEPLOYMENT.md`](DEPLOYMENT.md)
to run this on Render instead of locally.
