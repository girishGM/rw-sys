# User Acceptance Testing Script

**Who this is for:** a business stakeholder accepting the system, not an engineer. No command
line, no API calls, no database — every step below is a click, a typed value, or reading a
screen. If a step ever asks you to do something you can't find, that is a real finding, not a
mistake on your part — write it in the Notes column and keep going with the next step where
possible.

**Before you begin**

1. You will need the web address of the portal (ask whoever set up your test environment — it
   will look like `https://<something>/login`, or `http://localhost:8080/login` on a local
   demo).
2. You will be given a single Super Admin login (email + password) to start. Every other login
   in this script, you create yourself, as you go — that is deliberately part of what this test
   proves.
3. **If your Dashboard's summary boxes show red "Couldn't load ..." or "NOT_FOUND":** this was a
   known, already-filed defect (T-092) during earlier hardening; it is now fixed and closed, and
   every Dashboard screen should show real numbers and lists, not error tiles (confirmed live,
   for all six roles, on 2026-08-24). **If you still see the broken tiles, that is a real,
   reportable finding, not this known issue** — the most likely cause is a deployment that has
   not been rebuilt/redeployed since the fix landed (`docs/DEPLOYMENT.md`); tell your test
   coordinator either way, since it means either a regression or a stale environment.
4. Each step has a **Pass/Fail** column. Circle or type one for every step. A step "fails" if
   the **Expected result** does not happen — write what happened instead in Notes.
5. Where a step says "note this value," you'll need it again in a later step — keep the sheet
   or a notes app open as you go.

---

## Section 1 — Super Admin

**Who plays this role:** the person who governs the whole system — every country, every rule,
every reward, and who can see and change what every other role is allowed to do.

| # | Step | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Go to the portal address. Enter the Super Admin email and password you were given, and click **Log in**. | You land on a screen titled **Set up two-factor authentication**, showing a secret code and a QR-style code to scan. | | |
| 2 | Using an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, or similar), scan the code or type in the secret shown. Enter the 6-digit code your app now shows into **Verification code**, and click **Enable two-factor authentication**. | A screen titled **Save your recovery codes** appears, showing a list of one-time backup codes. | | |
| 3 | Write down (or screenshot) the recovery codes somewhere safe, then click the button confirming you've saved them. | You are asked to change your password (your first login always requires this). | | |
| 4 | Enter your current password, then a new password of your choosing (at least 12 characters, a mix of upper/lower case, a number and a symbol), confirm it, and click **Change password**. | You land on the **Dashboard**. Your name appears top-right. | | |
| 5 | Click **Countries** in the left-hand menu, then **Add country**. | A form appears asking for an ISO country code, currency, name, timezone and dialing code. | | |
| 6 | Fill in a real two-letter country code (e.g. `MY`), currency `MYR`, a name, timezone `Asia/Kuala_Lumpur`, dialing code `+60`. Turn on **Onboard the Country Admin now**, and fill in an email and name for that Country Admin. Click **Create country**. | The country appears in the list. A **Reveal** button appears for the new Country Admin's temporary password. | | |
| 7 | Click **Reveal**, and note the password shown. Click **Done**. | The temporary password disappears from view (it is shown once only — this is deliberate). *Note this password and the Country Admin's email — you need them for Section 2.* | | |
| 8 | Click **Rules** in the left menu, then **Add rule**. Choose any category/sub-category offered, give it a code and name, and an expression such as `amount >= :minSpend`. Click **Create rule**. | The new rule appears in the Rules list. | | |
| 9 | Open the rule you just created, click **Assign countries**, tick the country you created in step 6, and save. | The country now appears under this rule's assigned countries. | | |
| 10 | Click **Rewards** in the left menu, then **Add reward**. Give it a system code, a name, a reward type, and a connector type. Click **Create reward**. | The new reward appears in the Rewards list. | | |
| 11 | Open the reward, assign it to the same country as step 9, then open its **Policies** tab and add a policy (a code and a name). | The country and the policy both appear against this reward. | | |
| 12 | Click **Access Control** in the left menu. Choose the **Maker** tab. | A list of menu items appears, each with an on/off switch, and a **Permissions** tab alongside. | | |

*Keep this window open — you'll return to Access Control in Section 8 (Negative Checks).*

---

## Section 2 — Country Admin

**Who plays this role:** the person responsible for one country — they onboard the tenants
(client organisations) operating in that country.

| # | Step | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Log out of the Super Admin session (top-right menu → **Log out**). Log in with the Country Admin email and temporary password from Section 1, step 7. | You are asked to change your password (first login). | | |
| 2 | Set a new password as in Section 1, step 4. | You land on the **Dashboard**, scoped to your one country. | | |
| 3 | Click **Tenants** in the left menu, then **Add tenant**. | A form asks for a tenant code, name, and whether to onboard the Tenant Admin now. | | |
| 4 | Fill in a code and name, turn on **Onboard the Tenant Admin now**, fill in an email and name, and click **Create tenant**. | The tenant appears in the list. A **Reveal** button appears for the Tenant Admin's temporary password. | | |
| 5 | Click **Reveal**, note the password, click **Done**. | *Note this password and the Tenant Admin's email — you need them for Section 3.* | | |
| 6 | Open the tenant you just created, and click **Activate**. | The tenant's status changes to **active**. | | |

---

## Section 3 — Tenant Admin

**Who plays this role:** the person who runs one client organisation — they add the merchant
locations, and create the Maker/Checker/Merchant staff who will actually use the system day to
day.

| # | Step | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Log out. Log in with the Tenant Admin email/temporary password from Section 2, step 5, and set a new password. | You land on the **Dashboard**, scoped to your one tenant. | | |
| 2 | Click **Merchants**, then **Add merchant**. Fill in a merchant code, the country code from Section 1 (e.g. `MY`), and a name. Click **Create merchant**. | The merchant appears in the Merchants list. | | |
| 3 | Open the merchant. Click the **Stores** tab, then **Add store**, fill in a code and name, and save. | The store appears under the merchant. | | |
| 4 | Click the **Activities** tab, then **Link activity**. (Your test coordinator will give you an activity ID to enter — this is a legacy catalogue this portal does not create records in directly.) | The activity appears linked to the merchant. | | |
| 5 | Click **Users**, then **Add user**. Choose role **Maker**, fill in an email and display name, and click **Create user**. Click **Reveal**, note the password, tick the confirmation checkbox, click **Done**. | *Note the Maker's email and password — you need them for Section 4.* | | |
| 6 | Repeat step 5, this time choosing role **Checker**. | *Note the Checker's email and password — you need them for Section 5.* | | |
| 7 | Repeat step 5 again, choosing role **Merchant**. When asked for a **Merchant ID**, enter the numeric ID of the merchant you created in step 2 (visible in the page address, or ask your coordinator). | *Note the Merchant user's email and password — you need them for Section 6.* | | |

---

## Section 4 — Maker

**Who plays this role:** the person who builds a reward campaign and submits it for approval.
A Maker can never approve their own work.

| # | Step | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Log out. Log in with the Maker email/temporary password from Section 3, step 5, and set a new password. | You land on the **Dashboard**. The left menu shows **My Campaigns**, **Create Campaign** and **Create with AI**. | | |
| 2 | Click **Create Campaign**. Fill in a campaign code, name, a start date and an end date, and click **Create draft**. | You move to the wizard's **Merchants** step. | | |
| 3 | Select the merchant your Tenant Admin created (Section 3, step 2) as a participating merchant, and click **Next**. | You move to the **Journey** step. | | |
| 4 | Type a tracker name (e.g. "Main tracker") and click **Add**. Click the tracker to open it. Give a step a name, choose the linked activity, and click **Add step**. Click **Next**. | You move to the **Rules** step. | | |
| 5 | Choose the rule your Super Admin created (Section 1, step 8) from **Add a rule**, click **Add**, then **Next**. | You move to the **Rewards** step. | | |
| 6 | Choose the reward policy your Super Admin created (Section 1, step 11) from **Add a reward** at the campaign level, click **Attach**, then **Next**. | You move to the **Budgets** step. | | |
| 7 | Leave budgets blank (an uncapped campaign is allowed) and click **Next**. | You reach the **Review** step, summarising everything you've built. | | |
| 8 | Click **Submit for approval**. | The campaign's status changes to **Pending**, and it is no longer editable by you. | | |

*Stay logged in as this Maker — you'll come back in Section 7.*

---

## Section 5 — Checker

**Who plays this role:** the person who reviews a Maker's submitted campaign and approves,
rejects, or returns it for changes. A Checker can never approve a campaign they themselves
submitted while acting as a Maker.

| # | Step | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Log in (a new browser window, or after logging out) with the Checker email/temporary password from Section 3, step 6, and set a new password. | You land on the **Dashboard**, showing an **Approval Queue** in the left menu. | | |
| 2 | Click **Approval Queue**. | The campaign your Maker submitted in Section 4 appears in the list. | | |
| 3 | Click the campaign's row. | The full detail of what was submitted is shown, along with **Approve**, **Reject** and **Return** actions. | | |
| 4 | Click **Approve**, confirm in the dialog that appears. | The campaign's status changes to **Approved**. | | |

---

## Section 6 — Merchant

**Who plays this role:** a read-only participant — a merchant location can see which campaigns
it is part of, but cannot create or change anything.

| # | Step | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Log in with the Merchant user's email/temporary password from Section 3, step 7, and set a new password. | You land on the **Dashboard**. The left menu shows only **My Campaigns**. | | |
| 2 | Click **My Campaigns**. | The approved campaign from Section 5 appears in the list, with status **active**. | | |
| 3 | Look for any button to create, edit or delete a campaign. | There is none — this screen is read-only, matching this role's purpose. | | |

---

## Section 7 — Maker sees the outcome

| # | Step | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Return to the Maker's browser window from Section 4 (or log back in). Open the campaign you submitted. | Its status now reads **Active**, reflecting the Checker's approval. | | |

---

## Section 8 — Negative checks (things the system must refuse)

These are the checks a business owner cares about most — proving the system's rules are
actually enforced, not just documented.

| # | Step | Expected result | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | **Self-approval is blocked.** Ask your test coordinator to promote your Section 4 Maker account to Checker (this requires a direct database change today — there is no self-service "change my role" button, by design). Log in again as that account and try to approve the very campaign it submitted while it was a Maker. | The system refuses with a clear error, something like "self-approval forbidden." The campaign remains **Pending**, untouched. | | |
| 2 | **Cross-tenant access is blocked.** As the Section 3 Tenant Admin, try to type another tenant's web address directly into the browser (ask your coordinator for one from a different Country Admin's tenant, if available). | You are shown a "not found" page — not the other tenant's data. | | |
| 3 | **Direct URL access while logged out is blocked.** Log out completely. Try typing the address of any screen you used earlier directly into the browser (e.g. the Users screen). | You are sent straight to the **Log in** screen, not the page you asked for. | | |
| 4 | **A Maker cannot reach Super-Admin-only screens.** While logged in as a Maker, try typing the Access Control screen's address directly into the browser. | You are shown a "You don't have access to this page" message. | | |
| 5 | **Toggling a menu item off actually removes access, not just the link.** Return to the Super Admin's Access Control screen (kept open from Section 1, step 12). Turn off the Maker role's **Create Campaign** item and save. Also open the **Permissions** tab and remove the Maker role's `campaign` → `create` permission, and save. | Both saves complete without error. | | |
| 6 | Log in again as your Section 4 Maker (or a fresh one). | **Create Campaign** no longer appears in the left menu, **and** typing `/campaigns/new` directly into the browser also shows "You don't have access to this page" — not just a hidden link. | | |

---

## Sign-off

| Role | Tester name | Date | Overall result (Pass / Pass with notes / Fail) |
|---|---|---|---|
| Super Admin | | | |
| Country Admin | | | |
| Tenant Admin | | | |
| Maker | | | |
| Checker | | | |
| Merchant | | | |
| Negative checks | | | |

Any step marked **Fail**, or any unexpected behaviour written in a Notes column, should be
raised with the delivery team before go-live — see `docs/KNOWN-LIMITATIONS.md` first, in case
it is already a disclosed, tracked item rather than a new finding.
