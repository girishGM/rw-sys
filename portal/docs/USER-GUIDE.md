# User Guide

Every screenshot in this guide was captured from a real, running instance of the portal
(the `docker-compose.yml` stack, `docs/DEPLOYMENT.md`), not mocked up — what you see here is
what the screen actually looks like today.

**A note on the Dashboard screenshots below:** earlier drafts of this guide showed every
Dashboard's summary boxes (and the "Recent Admin Activity"/similar list beneath them) as red
"Couldn't load ..." or "NOT_FOUND" tiles — a real, tracked defect (T-092: the back end had no
route to supply this data). **That defect is now fixed**, and every Dashboard screenshot below
was re-captured after the fix, showing real numbers and lists. If your own Dashboard still shows
error tiles, it is not this known issue — it means your environment is running an older build;
see `docs/DEPLOYMENT.md` for how to redeploy.

## Signing in, for everyone

1. Go to the portal's web address. You'll see the **Log in** screen
   (`screenshots/01-login.png`) — enter the email and password you were given.
2. **First login only:** you'll be asked to change your password. Enter your current
   (temporary) password once, then a new one twice (`screenshots/04-change-password.png`). The
   new one needs to be at least 12 characters with a mix of upper/lower case, a number and a
   symbol.
3. **Super Admin only:** before the password change, you'll also be asked to set up
   two-factor authentication (`screenshots/02-mfa-enrol.png`) — scan the code shown with an
   authenticator app, enter the 6-digit code it gives you, and save the one-time recovery codes
   you're shown next (`screenshots/03-mfa-recovery-codes.png`). Every other role does not need
   this in this release (`docs/KNOWN-LIMITATIONS.md` §3).
4. After that, every login is just email + password (and, for Super Admin, a 6-digit code from
   your authenticator app).

Every screen you're not allowed to see is simply not offered — the left-hand menu only ever
shows what your role can do, and the same rule is enforced again on the server even if you type
a web address directly (`screenshots/53-forbidden-page.png` shows what happens if you try).

---

## Super Admin

**What you can do:** create countries and their first Country Admin; author Rules and Rewards
(the only role that can); assign Rules/Rewards to countries; control what every other role sees
and can do (Access Control); read the full audit trail.

**Dashboard** (`screenshots/05-super-admin-dashboard.png`) — your landing page after login. The
left menu shows every Super-Admin screen: Countries, Rules, Rewards, Definition Requests,
Users, Access Control, Service Grants, Audit Log.

### Countries

- **Countries** (`screenshots/06-countries-list.png`) lists every onboarded country.
- **Add country** (`screenshots/07-add-country-modal.png`) creates a new one, and optionally
  its first Country Admin in the same step. If you onboard the Country Admin now, you'll be
  shown their one-time temporary password immediately after
  (`screenshots/08-temporary-password-reveal.png`) — **write it down or share it securely now;
  it cannot be viewed again.** After creating it, the country appears in the list
  (`screenshots/09-countries-list-after-create.png`).

### Rules

- **Rules** (`screenshots/10-rules-list.png`) lists every rule.
- **Add rule** (`screenshots/11-add-rule-modal.png`) creates one — pick a category and
  sub-category, give it a code, name and an expression (the condition that decides when the
  rule applies).
- Opening a rule (`screenshots/12-rule-detail.png`) shows its detail and an **Assign
  countries** button — use it to choose which countries may use this rule
  (`screenshots/13-rule-assign-countries.png`). Only Super Admin can author a rule; every other
  role can only pick from rules already assigned to their country when building a campaign.

### Rewards

- **Rewards** (`screenshots/14-rewards-list.png`) lists every reward system.
- **Add reward** (`screenshots/15-add-reward-modal.png`) creates one — a system code, name,
  reward type (e.g. `monetary`) and a connector type (how the reward is actually delivered).
- Opening a reward (`screenshots/16-reward-detail.png`) shows its connector configuration, plus
  **Assign countries** (same pattern as Rules) and a **Policies** tab. A reward needs at least
  one **policy** before a campaign can use it — **Add policy**
  (`screenshots/17-add-policy-modal.png`) gives it a code and a name; a campaign later attaches
  to a specific policy, not the reward system directly.

### Access Control — the screen that controls every other role

`screenshots/18-access-control-nav.png` shows the **Navigation** tab for one role at a time
(the tabs across the top pick the role). Every menu item that role can see has an on/off
switch. Turning one off removes it from that role's menu **and** blocks the matching web
address directly — the two are linked (see `docs/HANDOVER.md` for exactly how).

`screenshots/19-access-control-permissions.png` shows the **Permissions** tab for the same
role — a grid of what that role may do (view/create/update/...) to each kind of thing in the
system (campaigns, rules, users, ...). This is the control that actually decides what the
server allows; the navigation tab only controls what's shown on screen.

There is also a **Dashboard widgets** tab (not pictured) with the same shape, for which
summary tiles a role sees on their Dashboard.

### Audit Log

`screenshots/20-audit-viewer.png` — every administrative and campaign action, searchable and
exportable. If you have a `traceId` from an error message, paste it here to see everything that
happened during that one request.

---

## Country Admin

**What you can do:** onboard the tenants (client organisations) operating in your one country,
and their first Tenant Admin.

**Dashboard** (`screenshots/21-country-admin-dashboard.png`) — your landing page, scoped to
your one country.

- **Tenants** (`screenshots/22-tenants-list.png`) lists every tenant in your country.
- **Add tenant** (`screenshots/23-add-tenant-modal.png`) creates one, optionally with its first
  Tenant Admin in the same step (same one-time password reveal pattern as Country creation).
- A new tenant starts inactive. Open it (`screenshots/24-tenant-detail.png`) and click
  **Activate** to let its Tenant Admin and staff actually sign in
  (`screenshots/25-tenant-activated.png`).

---

## Tenant Admin

**What you can do:** manage your one tenant's merchants and their stores/activities, and
create every kind of staff user beneath you (Maker, Checker, Merchant).

**Dashboard** (`screenshots/26-tenant-admin-dashboard.png`) — scoped to your one tenant.

### Merchants

- **Merchants** (`screenshots/27-merchants-list.png`) lists every merchant your tenant
  operates.
- **Add merchant** (`screenshots/28-add-merchant-modal.png`) creates one — a code, the
  country it operates in, and a name.
- Opening a merchant shows tabs for **Details**, **Stores** and **Activities**:
  - **Add store** (`screenshots/30-add-store-modal.png`) adds a physical/online location under
    the merchant; the Stores tab then lists them (`screenshots/31-merchant-stores-tab.png`).
  - **Link activity** (`screenshots/31a-link-activity-modal.png`) connects a merchant to an
    activity from the legacy activity catalogue by its numeric ID (this portal does not create
    activities itself — ask your coordinator/administrator for the ID). Once linked, it appears
    on the Activities tab (`screenshots/31b-merchant-activities-tab.png`) and becomes available
    to Makers building a campaign for this merchant.

### Users

- **Users** (`screenshots/32-users-list.png`) lists everyone with portal access in your
  tenant.
- **Add user** (`screenshots/33-add-user-modal.png`) creates a Maker, Checker or Merchant
  user. Pick the role, an email and a display name; for a Merchant user you'll also be asked
  for the Merchant ID they belong to. As with every account this portal creates, you're shown
  a one-time temporary password immediately after, and asked to confirm you've shared it
  securely before the dialog will let you close it. `screenshots/34-users-list-after-create.png`
  shows the resulting list.

---

## Maker

**What you can do:** build a reward campaign, step by step, and submit it for approval. You
can never approve your own submission — that is enforced by the server, not just hidden in the
menu.

**Dashboard** (`screenshots/35-maker-dashboard.png`) — the left menu shows **My Campaigns**,
**Create Campaign** and **Create with AI** (a conversational alternative to the step-by-step
wizard, covered separately — ask your administrator if this is enabled for you).

- **My Campaigns** (`screenshots/36-campaigns-list.png`) lists everything you've built.
- **Create Campaign** starts the wizard, a seven-step process shown across the top of every
  wizard screen:

  1. **Basics** (`screenshots/37-campaign-wizard-basics.png`) — code, name, start/end date.
  2. **Merchants** (`screenshots/38-campaign-wizard-merchants.png`) — which merchant(s) this
     campaign runs at.
  3. **Journey** (`screenshots/39-campaign-wizard-journey.png`,
     `screenshots/40-campaign-wizard-journey-tracker.png`) — build one or more "trackers" (a
     named sequence of steps, e.g. "Main tracker"), each with one or more steps naming which
     activity qualifies (e.g. "Qualifying purchase").
  4. **Rules** (`screenshots/41-campaign-wizard-rules.png`) — bind one of the rules your Super
     Admin authored and assigned to your country to a step or the whole tracker, and, if the
     rule takes parameters, supply the actual values for this campaign (e.g. a minimum spend
     amount).
  5. **Rewards** (`screenshots/42-campaign-wizard-rewards.png`) — attach a reward policy at
     the campaign level, a tracker level, or an individual step level, depending on when the
     reward should pay out.
  6. **Budgets** (`screenshots/43-campaign-wizard-budgets.png`) — optionally cap total spend or
     per-customer spend. Leaving this step blank is allowed — the campaign is simply uncapped.
  7. **Review** (`screenshots/44-campaign-wizard-review.png`) — a full summary of everything
     you've built, and the **Submit for approval** button.

- After submitting, the campaign's detail page (`screenshots/45-campaign-detail-pending.png`)
  shows status **Pending** and is no longer editable by you — it now belongs to a Checker's
  queue.

---

## Checker

**What you can do:** review a Maker's submitted campaign and approve, reject, or return it for
changes. You can never approve a campaign you yourself submitted while acting as a Maker — the
server checks the actual account, not just the role you're currently using.

**Dashboard** (`screenshots/46-checker-dashboard.png`) — the left menu shows **Approval
Queue**.

- **Approval Queue** (`screenshots/47-approvals-queue.png`) lists everything waiting on you.
- Opening a submission (`screenshots/48-approval-detail.png`) shows exactly what was built —
  merchants, journey, rules, rewards, budgets — so you can review it before deciding.
- **Approve** opens a confirmation dialog (`screenshots/49-approve-decision-dialog.png`).
  Confirming it moves the campaign to **Approved**
  (`screenshots/50-campaign-approved.png`) — that page also shows whether anything changed
  between submission and your review ("Changes since submission"), so you're never approving
  something different from what you looked at.
- **Reject** and **Return** work the same way, with a required comment explaining why.

---

## Merchant

**What you can do:** see which campaigns your merchant location participates in. Nothing
else — this role is read-only by design.

**Dashboard** (`screenshots/51-merchant-dashboard.png`) — the left menu shows only **My
Campaigns**.

- **My Campaigns** (`screenshots/52-merchant-campaigns.png`) shows active-campaign and
  activity counts, and a table of every campaign your merchant is part of. There is no way to
  create, edit or approve anything from here.

---

## Screens every role shares

- **Notifications** — the bell icon, top-right of every screen, shows a red badge when you
  have unread items (visible in `screenshots/50-campaign-approved.png`'s top bar for the
  Checker who just approved a campaign). Click it to see what changed that concerns you.
- **"You don't have access to this page"** (`screenshots/53-forbidden-page.png`) — shown if
  you reach (by a stale bookmark, a shared link, or a role change) a screen your current role
  isn't permitted to see. This is expected behaviour, not an error.
- **Blast History** (Super Admin/Country Admin — `screenshots/55-blast-history.png`) — a
  record of every rule/reward version ever distributed to a country, and to whom. Empty until
  a Super Admin publishes and distributes a new version of a rule or reward
  (`06-VERSIONING.md`) — not covered step-by-step in this guide as it is an advanced,
  infrequent operation; ask your administrator if you need to do this.
- **Definition Requests** (Country Admin, Tenant Admin, Super Admin —
  `screenshots/56-definition-requests.png`) — the way a Country/Tenant Admin asks the Super
  Admin to author a rule or reward they need but cannot create themselves (only Super Admin may
  author one, `00-ARCHITECTURE.md` §5.2). Empty until someone raises a request.
