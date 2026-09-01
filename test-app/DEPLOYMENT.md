# Deploying test-app to Render

Two Render web services, no database (test-app has none — see `README.md`). Both Dockerfiles
and `render.yaml` were built and run locally against real Docker before this doc was written —
`tracking-service` logged into a real `portal/back-end` and served real data through the built
image, and the frontend image's nginx proxy (including the SSE endpoint) was confirmed working
end to end.

## Prerequisite: portal must already be deployed and reachable

`tracking-service` is a real REST client of `portal/back-end` — there is no offline/mocked mode.
Before deploying test-app, you need `portal/back-end` running somewhere `tracking-service` can
reach over HTTPS (Render itself, per `portal/render.yaml` and `portal/docs/DEPLOYMENT.md`, or
anywhere else reachable). You also need a seeded `tenant_admin` account on that deployment —
same requirement as local dev, see `README.md`'s prerequisites §3 for why `tenant_admin` and not
`merchant`.

## 1. Push this repo to a place Render can see it

Render Blueprints deploy from a connected Git repo. If this repo isn't already connected, connect
it in the Render dashboard first (New + → Blueprint → pick this repo).

## 2. Deploy the Blueprint

`test-app/render.yaml` defines both services. In the Render dashboard: **New +** → **Blueprint**
→ select this repo → point it at `test-app/render.yaml`. Render will show a plan (2 web
services: `test-app-tracking-service`, `test-app-frontend`) — review and apply it.

This creates both services but they won't come up healthy yet — `test-app-tracking-service`
needs its `sync: false` env vars filled in first (Render creates the *keys* from the Blueprint,
not the secret values, deliberately — see `render.yaml`'s own comments).

## 3. Fill in `test-app-tracking-service`'s secrets

In the Render dashboard, open **test-app-tracking-service → Environment**, and set:

| Key | Value |
|---|---|
| `PORTAL_BASE_URL` | The deployed portal API's public URL, e.g. `https://reward-portal-api.onrender.com` (no trailing slash) |
| `PORTAL_LOGIN_EMAIL` | The seeded `tenant_admin` account's email |
| `PORTAL_LOGIN_PASSWORD` | Its password |

Save — Render redeploys the service automatically. Check its **Logs** tab: you should see
`tracking-service listening on http://localhost:4001` and no login error. If you see a login
failure, double check the account is genuinely `tenant_admin` (not `merchant`) and that
`PORTAL_BASE_URL` is reachable from Render (not `localhost`).

## 4. Confirm `test-app-frontend`

`TRACKING_SERVICE_UPSTREAM_HOST` is wired automatically via `render.yaml`'s `fromService`
reference — nothing to fill in here manually unless that cross-service reference fails to
resolve on your Render account (rare; if so, set it by hand to
`test-app-tracking-service`'s internal hostname, shown on that service's own page).

Once both services show **Live**, open `test-app-frontend`'s public URL. You should see the
Dashboard with real campaign data — same golden path as `README.md` describes for local dev.

## Verifying it actually works (don't just trust "Live")

1. `curl https://<tracking-service-url>/health` → `{"status":"ok"}`.
2. `curl https://<frontend-url>/nginx-health` → `ok`.
3. `curl https://<frontend-url>/api/customers` → the 3-customer roster (proves the nginx → tracking-service proxy works, not just that each service independently boots).
4. Open the frontend URL in a browser and run through `README.md`'s golden path (theme switch,
   customer switch, submit two "Weekend Transaction" activities as Marcus Tan, confirm the
   reward-earned toast and My Rewards update).

## Known simplifications (fine for a demo, not for anything longer-lived)

- **In-memory state resets on every deploy/restart.** Render's free plan also spins down an idle
  service and cold-starts it on the next request — `tracking-service` re-logs-into portal and
  re-seeds its demo state on every cold start, which is a several-second delay a real user would
  notice. Fine for a demo, not something to promise uptime against.
- **Free-plan services sleep after inactivity.** The first request after a while will be slow
  (cold start of both services). Upgrade the plan in `render.yaml` if that matters for a demo
  you're about to show someone live.
- **No CDN/caching layer, no autoscaling** — a single instance of each service, same as
  `portal/render.yaml`'s own "demo deployment, not production topology" framing.
