/**
 * T-050 — TC-1, the golden journey: the complete delegation chain, walked through the real
 * browser against the real API and the real (ephemeral) database, exactly as
 * `project-plan/tasks/T-050-e2e-tests.md`'s "The golden journey" section lists it — with one
 * documented exception (step 1) explained in the block comment at that step below and, at
 * length, in `global-setup.ts`'s own header and this task's completion report.
 *
 * Every entity this spec creates is built through the real UI, not `utils/scenario.ts` — that
 * module exists for every *other* spec's preconditions; this is the one spec whose entire job is
 * proving those same screens work end to end.
 */
import { test, expect } from '../fixtures';
import { superAdminContext } from '../fixtures/superAdminSession';
import { realUiLogin, expectOnDashboard } from '../fixtures/uiAuth';
import { createActivity } from '../utils/db';
import { uniqueCountryCode, uniqueEmail, uniqueTag } from '../utils/ids';

test.describe.configure({ mode: 'serial' });

/**
 * Steps 12-13 below deliberately disable the `maker` **role's** "Create Campaign" nav item and
 * `campaign:create` permission via Access Control — `role_nav_configs`/`role_entity_permissions`
 * are keyed by role, not by tenant or account (`access-control.spec.ts`'s own header says the same
 * thing about `tenant_admin`), so this is a global mutation, not one scoped to this journey's own,
 * freshly created Maker. Left unrestored, it silently breaks *every other* spec that needs
 * `scenario.maker` (the one, run-wide shared Maker every other spec reads — `utils/state.ts`'s own
 * header) to still have `campaign:create`: `timezone.spec.ts`'s TC-2 and `responsive.spec.ts`'s
 * 375px wizard step both hung on a `/campaigns/new` field that was never going to render, purely
 * because this test happened to run first alphabetically. **Found live, T-050 2026-08-20** — not
 * hypothetical. `test.afterAll` restores both, via the real API (not the UI, so restoration cannot
 * itself be skipped by whatever the test body's own assertions did) and unconditionally (afterAll
 * runs whether the test above passed or failed) — the same discipline
 * `negative-journeys.spec.ts`'s TC-N9/TC-N10 already apply to the accounts they mutate.
 */
interface NavConfigSnapshot {
  readonly version: number;
  readonly items: readonly {
    readonly navKey: string;
    readonly label: string;
    readonly icon: string | null;
    readonly path: string;
    readonly parentNavKey: string | null;
    readonly sortOrder: number;
    readonly enabled: boolean;
  }[];
}
interface PermissionsSnapshot {
  readonly version: number;
  readonly permissions: Record<string, readonly string[]>;
}

let originalMakerNav: NavConfigSnapshot | null = null;
let originalMakerPermissions: PermissionsSnapshot | null = null;

test.beforeAll(async ({ superAdminApi }) => {
  originalMakerNav = await superAdminApi.get<NavConfigSnapshot>('/admin/access-control/nav/maker');
  originalMakerPermissions = await superAdminApi.get<PermissionsSnapshot>(
    '/admin/access-control/permissions/maker',
  );
});

test.afterAll(async ({ superAdminApi }) => {
  // `expectedVersion` is optimistic-concurrency, not a snapshot pointer (implementation note 5,
  // `putPermissionsRequestSchema`'s own header) — step 12/13 already advanced both rows' versions
  // past whatever `beforeAll` captured, so restoring must present the *current* version, not the
  // pre-mutation one, or the server correctly rejects this as "changed elsewhere". Only the
  // `items`/`permissions` content comes from the original snapshot; the version comes from a fresh
  // read taken right before the write.
  if (originalMakerNav) {
    const current = await superAdminApi.get<NavConfigSnapshot>('/admin/access-control/nav/maker');
    await superAdminApi.put('/admin/access-control/nav/maker', {
      expectedVersion: current.version,
      items: originalMakerNav.items,
    });
  }
  if (originalMakerPermissions) {
    const current = await superAdminApi.get<PermissionsSnapshot>(
      '/admin/access-control/permissions/maker',
    );
    await superAdminApi.put('/admin/access-control/permissions/maker', {
      expectedVersion: current.version,
      permissions: originalMakerPermissions.permissions,
    });
  }
});

test('golden journey: bootstrap through Maker nav revocation (TC-1)', async ({ browser, state }) => {
  // `playwright.config.ts`'s default (`timeout: 60_000`) is sized for an ordinary, single-screen
  // spec; this one is 13 real, unmocked steps across six real logins and a real campaign wizard,
  // each with real network round trips (encryption/decryption, multiple DB queries per request —
  // visible in this run's own structured logs). Found live (T-050, 2026-08-21): a full run on this
  // machine took the entire 60s budget and was killed mid-step-3 with every prior step already
  // passing, not stuck — a budget problem, not a correctness one. 180s is generous headroom without
  // masking a genuine hang (DoD's own "investigate every flake rather than adding a retry" is about
  // retries, not about a single spec's timeout matching the work it actually does).
  test.setTimeout(180_000);

  const tag = uniqueTag('GJ');
  const countryCode = uniqueCountryCode();

  // ---------------------------------------------------------------------------------------
  // Step 1 — "bootstrap Super Admin via CLI, first login, forced password change."
  //
  // Bootstrap-via-CLI, the real first login, the real MFA enrolment (through a real headless
  // browser — the inherited T-060 TC-1 criterion) and the forced password change all genuinely
  // happened — in `global-setup.ts`, once, for the whole run, not here. One constraint forces
  // that: `bootstrap-superadmin.ts` refuses a second `super_admin` outright ("A super_admin
  // already exists"), so this step cannot be repeated per spec or per run the way every other
  // actor in this journey is — there is exactly one "first login" for this role in the entire
  // run, and `global-setup.ts` is where it is spent (see that file's own header for the full
  // browser-driven flow). What this step *does* assert, through a real browser context seeded
  // with that already-completed session — see `superAdminSession.ts` — is the state that first
  // login actually produced: a working, unconfined `super_admin` session that lands cleanly on
  // the dashboard.
  // ---------------------------------------------------------------------------------------
  const superAdminCtx = await superAdminContext(browser, state);
  const superAdminPage = await superAdminCtx.newPage();
  await superAdminPage.goto(`${state.baseURL}/dashboard`);
  await expectOnDashboard(superAdminPage);

  // Step 2 — Super Admin creates country "Malaysia" + Country Admin.
  await superAdminPage.goto(`${state.baseURL}/countries`);
  await superAdminPage.getByRole('button', { name: 'Add country' }).click();
  await superAdminPage.getByLabel('ISO country code').fill(countryCode);
  await superAdminPage.getByLabel('Currency code').fill('MYR');
  await superAdminPage.getByLabel('Country name').fill(`Malaysia ${tag}`);
  await superAdminPage.getByLabel('Timezone (IANA)').fill('Asia/Kuala_Lumpur');
  await superAdminPage.getByLabel('Dialing code').fill('+60');
  await superAdminPage.getByRole('switch', { name: 'Onboard the Country Admin now' }).click();
  const countryAdminEmail = uniqueEmail('country-admin');
  await superAdminPage.getByLabel('Country Admin email').fill(countryAdminEmail);
  await superAdminPage.getByLabel('Country Admin name').fill(`Country Admin ${tag}`);
  await superAdminPage.getByRole('button', { name: 'Create country' }).click();

  await superAdminPage.getByRole('button', { name: 'Reveal' }).click();
  const countryAdminTempPassword = await superAdminPage
    .getByTestId('temporary-password-value')
    .innerText();
  await superAdminPage.getByRole('button', { name: 'Done' }).click();

  // Step 3 — Super Admin creates a Rule, assigns it to Malaysia.
  //
  // No parameters are added (`ParameterFieldsEditor` is left empty): a rule with parameters
  // would require the Maker to supply "dynamic values" in step 4 of the wizard below, which is a
  // real, separately-worth-testing path this spec does not need in order to prove the chain end
  // to end. Flagged as a coverage gap for a future, dedicated wizard spec in the completion
  // report's "Notes for the reviewer".
  await superAdminPage.goto(`${state.baseURL}/rules`);
  await superAdminPage.getByRole('button', { name: 'Add rule' }).click();
  await superAdminPage.getByRole('combobox', { name: /^Category/ }).click();
  await superAdminPage.getByRole('option', { name: 'E2E rule category' }).click();
  await superAdminPage.getByRole('combobox', { name: /^Sub-category/ }).click();
  await superAdminPage.getByRole('option', { name: 'E2E rule sub-category' }).click();
  const ruleCode = `${tag}_RULE`;
  await superAdminPage.getByLabel('Rule code').fill(ruleCode);
  await superAdminPage.getByLabel('Name').fill(`Min spend rule ${tag}`);
  await superAdminPage.getByLabel('Expression').fill('amount >= :minSpend');
  await superAdminPage.getByRole('button', { name: 'Create rule' }).click();

  await superAdminPage.getByRole('cell', { name: ruleCode }).click();
  await superAdminPage.getByRole('button', { name: 'Assign countries' }).click();
  // Scoped to the open dialog (`role="dialog"`, `Modal.tsx`): an unscoped
  // `getByRole('button', { name: 'Countries', exact: false })` is a strict-mode violation — it
  // also matches the "Assign countries" trigger button still in the DOM behind the dialog, since
  // Playwright's non-exact name match is a case-insensitive substring match ("Assign countries"
  // contains "Countries"). Found live, T-050 2026-08-21.
  const assignRuleCountriesDialog = superAdminPage.getByRole('dialog', { name: /Assign countries/ });
  await assignRuleCountriesDialog.getByRole('button', { name: 'Countries', exact: false }).click();
  await superAdminPage.getByRole('option', { name: new RegExp(`\\(${countryCode}\\)`) }).click();
  // Not `keyboard.press('Escape')`: `MultiSelect.tsx` and `Modal.tsx` each register their own
  // document-level `keydown` listener for `Escape` (`useEscapeKey.ts`), and neither stops the
  // other from also firing — pressing Escape to close just the open dropdown closes the whole
  // dialog too, discarding the selection before "Save changes" can be clicked. Reproduced live,
  // T-050 2026-08-21 (the dialog was gone and `getByRole('button', { name: 'Save changes' })`
  // waited out the full test timeout). Out of this task's file scope to fix (front-end/**, R9) —
  // clicking the dialog heading instead closes only the dropdown, via `MultiSelect`'s own
  // `useOutsideClick`, which never touches the modal.
  await assignRuleCountriesDialog.getByRole('heading', { name: /Assign countries/ }).click();
  await assignRuleCountriesDialog.getByRole('button', { name: 'Save changes' }).click();

  // Step 4 — Super Admin creates a Reward, assigns it to Malaysia.
  await superAdminPage.goto(`${state.baseURL}/rewards`);
  await superAdminPage.getByRole('button', { name: 'Add reward' }).click();
  const rewardSystemCode = `${tag}_REWARD`;
  await superAdminPage.getByLabel('System code').fill(rewardSystemCode);
  await superAdminPage.getByLabel('Name', { exact: true }).fill(`Cashback ${tag}`);
  await superAdminPage.getByLabel('Reward type').fill('monetary');
  await superAdminPage.getByRole('combobox', { name: /^Connector type/ }).click();
  await superAdminPage.getByRole('option', { name: 'internal_api' }).click();
  await superAdminPage.getByRole('button', { name: 'Create reward' }).click();

  await superAdminPage.getByRole('cell', { name: rewardSystemCode }).click();
  await superAdminPage.getByRole('button', { name: 'Assign countries' }).click();
  // Same strict-mode fix as the rule assignment above — scope to the open dialog.
  const assignRewardCountriesDialog = superAdminPage.getByRole('dialog', { name: /Assign countries/ });
  await assignRewardCountriesDialog.getByRole('button', { name: 'Countries', exact: false }).click();
  await superAdminPage.getByRole('option', { name: new RegExp(`\\(${countryCode}\\)`) }).click();
  // Same Escape-cascades-to-the-modal issue as the rule assignment above — click the dialog
  // heading instead to close only the dropdown.
  await assignRewardCountriesDialog.getByRole('heading', { name: /Assign countries/ }).click();
  await assignRewardCountriesDialog.getByRole('button', { name: 'Save changes' }).click();

  await superAdminPage.getByRole('tab', { name: 'Policies' }).click();
  await superAdminPage.getByRole('button', { name: 'Add policy' }).click();
  // Scoped to the open dialog (`AddPolicyModal.tsx`, `title="Add policy"`) for the same reason as
  // the "Assign countries" fix above: once open, the modal's own submit button shares its exact
  // accessible name with the CardHeader trigger button still present behind it — an unscoped
  // `getByRole('button', { name: 'Add policy' })` is a strict-mode violation. Found live, T-050
  // 2026-08-21.
  const addPolicyDialog = superAdminPage.getByRole('dialog', { name: 'Add policy' });
  const policyCode = `${tag}_POLICY`;
  await addPolicyDialog.getByLabel('Policy code').fill(policyCode);
  const policyName = `Standard policy ${tag}`;
  await addPolicyDialog.getByLabel('Name', { exact: true }).fill(policyName);
  await addPolicyDialog.getByRole('button', { name: 'Add policy' }).click();

  // Disable the Maker's default nav item and permission *before* provisioning the Maker below is
  // wrong — step 12/13 must happen after the Maker has already used it (that is the point being
  // demonstrated) — so this stays where the journey puts it, after step 11.

  // Step 5 — Country Admin logs in, creates tenant "Acme" + Tenant Admin, activates it.
  const countryAdminCtx = await browser.newContext();
  const countryAdminPage = await countryAdminCtx.newPage();
  await realUiLogin(countryAdminPage, state.baseURL, {
    email: countryAdminEmail,
    password: countryAdminTempPassword,
  });
  await expectOnDashboard(countryAdminPage);

  await countryAdminPage.goto(`${state.baseURL}/tenants`);
  await countryAdminPage.getByRole('button', { name: 'Add tenant' }).click();
  const tenantCode = `T${tag}`.slice(0, 20);
  await countryAdminPage.getByLabel('Tenant code').fill(tenantCode);
  await countryAdminPage.getByLabel('Tenant name').fill(`Acme ${tag}`);
  await countryAdminPage.getByRole('switch', { name: 'Onboard the Tenant Admin now' }).click();
  const tenantAdminEmail = uniqueEmail('tenant-admin');
  await countryAdminPage.getByLabel('Tenant Admin email').fill(tenantAdminEmail);
  await countryAdminPage.getByLabel('Tenant Admin name').fill(`Tenant Admin ${tag}`);
  await countryAdminPage.getByRole('button', { name: 'Create tenant' }).click();

  await countryAdminPage.getByRole('button', { name: 'Reveal' }).click();
  const tenantAdminTempPassword = await countryAdminPage
    .getByTestId('temporary-password-value')
    .innerText();
  await countryAdminPage.getByRole('button', { name: 'Done' }).click();

  await countryAdminPage.getByRole('cell', { name: `Acme ${tag}` }).click();
  await countryAdminPage.getByRole('button', { name: 'Activate' }).click();
  await expect(countryAdminPage.getByText('active', { exact: true }).first()).toBeVisible();

  // Step 6/7 — Tenant Admin logs in, creates Maker, Checker and a Merchant user, and creates
  // merchant "Acme Store" with stores and activities.
  //
  // Executed in the reverse of the task file's own step numbering: `AddUserModal.tsx` requires an
  // existing, numeric `merchantId` for a `role: 'merchant'` user (`actorRole === 'tenant_admin' &&
  // role === 'merchant'` renders a required "Merchant ID" field), and the server rejects the
  // create with `VALIDATION_FAILED` when it is missing — reproduced live, T-050 2026-08-21 (a
  // real 180s timeout waiting for a "Reveal" button that never appears, because the create itself
  // never succeeded). No merchant exists yet at the point step 6 is literally numbered, so step 7
  // (create the merchant) must run first; the Merchant user created afterwards is still handed to
  // Merchant login in step 11 exactly as the journey describes, just built in dependency order
  // rather than document order.
  const tenantAdminCtx = await browser.newContext();
  const tenantAdminPage = await tenantAdminCtx.newPage();
  await realUiLogin(tenantAdminPage, state.baseURL, {
    email: tenantAdminEmail,
    password: tenantAdminTempPassword,
  });
  await expectOnDashboard(tenantAdminPage);

  await tenantAdminPage.goto(`${state.baseURL}/merchants`);
  await tenantAdminPage.getByRole('button', { name: 'Add merchant' }).click();
  const merchantCode = `M${tag}`.slice(0, 50);
  await tenantAdminPage.getByLabel('Merchant code').fill(merchantCode);
  await tenantAdminPage.getByLabel('Country code').fill(countryCode);
  await tenantAdminPage.getByLabel('Merchant name').fill(`Acme Store ${tag}`);
  await tenantAdminPage.getByRole('button', { name: 'Create merchant' }).click();
  await tenantAdminPage.getByRole('button', { name: 'Done' }).click();

  await tenantAdminPage.getByRole('cell', { name: merchantCode }).click();

  // "Add store"/"Link activity" both live under their own tab (`MerchantDetailPage.tsx` renders
  // "Details" first) — an unscoped click on either trigger button before switching tabs waits out
  // the full test timeout, since neither button exists yet on the still-showing "Details" panel.
  // Found live, T-050 2026-08-21.
  await tenantAdminPage.getByRole('tab', { name: 'Stores' }).click();
  await tenantAdminPage.getByRole('button', { name: 'Add store' }).click();
  // Scoped to the open dialog for the same reason as "Add policy" above — the modal's own submit
  // button (`AddMerchantStoreModal.tsx`) shares its exact accessible name with the trigger button
  // still present behind it.
  const addStoreDialog = tenantAdminPage.getByRole('dialog', { name: 'Add store' });
  const storeCode = `S${tag}`.slice(0, 50);
  await addStoreDialog.getByLabel('Store code').fill(storeCode);
  await addStoreDialog.getByLabel('Store name').fill(`Main store ${tag}`);
  await addStoreDialog.getByRole('button', { name: 'Add store' }).click();

  // No `POST /activities` endpoint exists anywhere in this API (`AddMerchantActivityModal.tsx`'s
  // own header) — a real deployment's legacy corporate system already holds this catalogue; this
  // suite inserts the one row it needs directly, the same documented gap `utils/db.ts`'s header
  // and this task's completion report both call out.
  const merchantId = Number(tenantAdminPage.url().split('/').pop());
  const merchantTenantId = await getTenantIdFromMerchant(tenantAdminPage, state.apiBaseURL, merchantId);
  const activityId = await createActivity(state.db, {
    tenantId: merchantTenantId ?? merchantId,
    typeId: state.seedData.activityTypeId,
    activityCode: `${tag}_ACT`,
    name: `Golden journey activity ${tag}`,
  });
  await tenantAdminPage.getByRole('tab', { name: 'Activities' }).click();
  await tenantAdminPage.getByRole('button', { name: 'Link activity' }).click();
  const linkActivityDialog = tenantAdminPage.getByRole('dialog', { name: 'Link activity' });
  await linkActivityDialog.getByLabel('Activity id').fill(String(activityId));
  await linkActivityDialog.getByRole('button', { name: 'Link activity' }).click();

  async function createDelegatedUser(
    role: 'Maker' | 'Checker' | 'Merchant',
    email: string,
    forMerchantId?: number,
  ) {
    await tenantAdminPage.goto(`${state.baseURL}/users`);
    await tenantAdminPage.getByRole('button', { name: 'Add user' }).click();
    await tenantAdminPage.getByRole('combobox', { name: /^Role/ }).click();
    await tenantAdminPage.getByRole('option', { name: role }).click();
    await tenantAdminPage.getByLabel('Email').fill(email);
    await tenantAdminPage.getByLabel('Display name').fill(`${role} ${tag}`);
    if (role === 'Merchant') {
      await tenantAdminPage.getByLabel('Merchant ID').fill(String(forMerchantId));
    }
    await tenantAdminPage.getByRole('button', { name: 'Create user' }).click();
    await tenantAdminPage.getByRole('button', { name: 'Reveal' }).click();
    const temporaryPassword = await tenantAdminPage.getByTestId('temporary-password-value').innerText();
    await tenantAdminPage
      .getByLabel('I have securely shared this password and the user knows to change it')
      .check();
    await tenantAdminPage.getByRole('button', { name: 'Done' }).click();
    return temporaryPassword;
  }

  const makerEmail = uniqueEmail('maker');
  const makerTempPassword = await createDelegatedUser('Maker', makerEmail);
  const checkerEmail = uniqueEmail('checker');
  const checkerTempPassword = await createDelegatedUser('Checker', checkerEmail);
  const merchantUserEmail = uniqueEmail('merchant-user');
  const merchantUserTempPassword = await createDelegatedUser('Merchant', merchantUserEmail, merchantId);

  // Step 8 — Maker logs in, runs the wizard, binds the rule with dynamic values, submits.
  const makerCtx = await browser.newContext();
  const makerPage = await makerCtx.newPage();
  const makerActive = await realUiLogin(makerPage, state.baseURL, {
    email: makerEmail,
    password: makerTempPassword,
  });
  await expectOnDashboard(makerPage);

  await makerPage.goto(`${state.baseURL}/campaigns/new`);
  const campaignCode = `${tag}_CAMPAIGN`;
  await makerPage.getByLabel('Campaign code').fill(campaignCode);
  await makerPage.getByLabel('Campaign name').fill(`Golden journey campaign ${tag}`);
  const today = new Date();
  const start = today.toISOString().slice(0, 10);
  const end = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await makerPage.getByLabel('Start date').fill(start);
  await makerPage.getByLabel('End date').fill(end);
  await makerPage.getByRole('button', { name: 'Create draft' }).click();
  await makerPage.waitForURL(/\/campaigns\/\d+$/);

  // T-076 fixed the wizard's step-loss-on-remount defect: `CampaignWizardPage.tsx` now carries the
  // current step on the router's own location state (see that file's header, "The current step
  // lives on the history entry, not in component state"), so the single `navigate()` in
  // `saveBasics` already lands the maker on step 2 "Merchants" directly — no extra click needed.
  // This spec used to work around the old defect here with one explicit "Next" click (T-050,
  // 2026-08-21), which is exactly what T-077 exists to remove: with the fix in place, that click
  // overshot to step 3 "Journey", so the very next line had no "Participating merchants" control on
  // screen and the run failed there. Reproduced live, T-077, 2026-08-21, with the stale click still
  // in place — the wizard showed "Journey" instead of "Merchants" at this point, then timed out
  // waiting for a "Participating merchants" control that only step 2 has. Asserted here via the
  // Stepper's own `aria-current="step"` (`components/Stepper.tsx`, T-021 TC-14) — a real DOM
  // attribute the browser sets from the actual current step, not a string this file merely repeats
  // (AGENT-PROTOCOL §3, "assert the observable property, not the implementation string").
  await expect(makerPage.locator('[aria-current="step"]')).toHaveText(/Merchants/);

  // Step 8b — Merchants.
  await makerPage.getByRole('button', { name: 'Participating merchants', exact: false }).click();
  await makerPage.getByRole('option', { name: new RegExp(`\\(${merchantCode}\\)`) }).click();
  await makerPage.keyboard.press('Escape');
  await makerPage.getByRole('button', { name: 'Next' }).click();

  // Step 8c — Journey: one tracker, one component bound to our activity.
  await makerPage.getByPlaceholder('Tracker name').fill('Main tracker');
  await makerPage.getByRole('button', { name: 'Add', exact: true }).click();
  await makerPage.getByText('Main tracker').click();
  await makerPage.getByLabel('Step name').fill('Qualifying purchase');
  await makerPage.getByRole('combobox', { name: /^Activity/ }).click();
  await makerPage.getByRole('option', { name: `Golden journey activity ${tag}` }).click();
  await makerPage.getByRole('button', { name: 'Add step' }).click();
  await makerPage.getByRole('button', { name: 'Next' }).click();

  // Step 8d — Rules: bind our rule to the one component.
  await makerPage.getByRole('combobox', { name: /^Add a rule/ }).click();
  await makerPage.getByRole('option', { name: new RegExp(`\\(${ruleCode}\\)`) }).click();
  await makerPage.getByRole('button', { name: 'Add', exact: true }).click();
  await makerPage.getByRole('button', { name: 'Next' }).click();

  // Step 8e — Rewards: attach our policy at campaign level.
  await makerPage.getByRole('combobox', { name: /^Add a reward/ }).first().click();
  await makerPage.getByRole('option', { name: new RegExp(policyName) }).click();
  await makerPage.getByRole('button', { name: 'Attach' }).first().click();
  await makerPage.getByRole('button', { name: 'Next' }).click();

  // Step 8f — Budgets: none set, uncapped campaigns are allowed (§8.4).
  await makerPage.getByRole('button', { name: 'Next' }).click();

  // Step 8g — Review and submit.
  await expect(makerPage.getByRole('button', { name: 'Submit for approval' })).toBeEnabled();
  await makerPage.getByRole('button', { name: 'Submit for approval' }).click();
  await makerPage.waitForURL(/\/campaigns\/\d+$/);

  // Step 9 — Checker logs in, sees the request, reviews the diff, approves.
  const checkerCtx = await browser.newContext();
  const checkerPage = await checkerCtx.newPage();
  await realUiLogin(checkerPage, state.baseURL, { email: checkerEmail, password: checkerTempPassword });
  await expectOnDashboard(checkerPage);

  await checkerPage.goto(`${state.baseURL}/approvals`);
  await checkerPage.getByRole('row', { name: new RegExp(campaignCode) }).click();
  await checkerPage.getByRole('button', { name: 'Approve', exact: true }).click();
  const decisionDialog = checkerPage.getByRole('dialog');
  await decisionDialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(checkerPage.getByText('Approved', { exact: true }).first()).toBeVisible();

  // Step 10 — Campaign is active; Maker sees the approval. The Maker is already sitting on this
  // campaign's own detail page from step 8g's submit; reload to pick up the Checker's decision.
  await makerPage.reload();
  await expect(makerPage.getByText('Active', { exact: true }).first()).toBeVisible();

  // Step 11 — Merchant logs in, sees the campaign on its dashboard.
  const merchantCtx = await browser.newContext();
  const merchantPage = await merchantCtx.newPage();
  await realUiLogin(merchantPage, state.baseURL, {
    email: merchantUserEmail,
    password: merchantUserTempPassword,
  });
  await expectOnDashboard(merchantPage);
  await merchantPage.goto(`${state.baseURL}/merchant/campaigns`);
  await expect(merchantPage.getByRole('cell', { name: campaignCode })).toBeVisible();

  // Step 12 — Super Admin opens Access Control, disables the Maker's "Create Campaign" nav item
  // (and, since the golden journey's own step 13 expects the *route* to be forbidden too, not
  // just the link hidden — a fact only `role_entity_permissions` governs, see
  // `RequirePermission.tsx`'s own header — the matching permission as well).
  //
  // **Both saves' own `PUT` responses are explicitly awaited and status-checked — found live,
  // T-050 2026-08-21, a real, reproduced race in this file, not the product.** `access-control.
  // service.ts`'s `role_entity_permissions`/`role_nav_configs`/`role_dashboard_widgets` share one
  // optimistic-concurrency counter per role (`rbac_cache_config.rbac_version:<role>` —
  // `RBAC_CONFIG_KEY.versionFor`, the same key regardless of which of the three a write is for).
  // Clicking "Save navigation" only waits for the *click* to dispatch, not for the mutation's own
  // network round trip — `expect(...).toHaveCount(0)` on text that was never present resolves
  // immediately without waiting on anything. The very next action (opening the "Permissions" tab)
  // could therefore fire its own `GET permissions/maker` while the nav `PUT`'s transaction was
  // still in flight — confirmed directly from the back end's own query log: the permissions GET's
  // `SELECT` interleaved between the nav PUT's own `UPDATE role_nav_configs` statements and its
  // `COMMIT`. A `GET` that lands before that commit reads the *pre-bump* version; the permissions
  // `PUT` a moment later then submits that stale `expectedVersion` against a row the nav save has
  // since moved on from, and `access-control.service.ts` correctly rejects it as changed elsewhere
  // (409) — a real conflict, honestly reported, just never caused by an actual second actor the
  // way the UI's "changed elsewhere" message implies. Awaiting each `PUT`'s own response before
  // the next action starts removes the race instead of masking it; checking each response's status
  // (matching `access-control.spec.ts`'s TC-12, which flagged the identical class of silent-failure
  // risk) turns any future regression here into a loud, attributable failure instead of a
  // downstream "Add merchant"/"You don't have access" timeout with no obvious cause.
  await superAdminPage.goto(`${state.baseURL}/admin/access-control`);
  await superAdminPage.getByRole('tab', { name: /^Maker/ }).click();
  await superAdminPage
    .getByRole('listitem')
    .filter({ hasText: 'Create Campaign' })
    .getByRole('switch')
    .click();
  const navSaveResponse = superAdminPage.waitForResponse(
    (response) =>
      response.url().includes('/admin/access-control/nav/maker') &&
      response.request().method() === 'PUT',
  );
  await superAdminPage.getByRole('button', { name: 'Save navigation' }).click();
  expect((await navSaveResponse).status(), 'PUT nav/maker').toBeLessThan(300);
  await expect(superAdminPage.getByText(/changed elsewhere/i)).toHaveCount(0);

  await superAdminPage.getByRole('tab', { name: 'Permissions' }).click();
  const campaignRow = superAdminPage
    .getByRole('row')
    .filter({ has: superAdminPage.getByRole('cell', { name: 'campaign', exact: true }) });
  await campaignRow.getByRole('checkbox', { name: 'create' }).uncheck();
  const permissionsSaveResponse = superAdminPage.waitForResponse(
    (response) =>
      response.url().includes('/admin/access-control/permissions/maker') &&
      response.request().method() === 'PUT',
  );
  await superAdminPage.getByRole('button', { name: 'Save permissions' }).click();
  expect((await permissionsSaveResponse).status(), 'PUT permissions/maker').toBeLessThan(300);
  await expect(superAdminPage.getByText(/changed elsewhere/i)).toHaveCount(0);

  // Step 13 — Maker logs in again: the item is gone and the route is forbidden.
  //
  // Uses `makerActive.password` (what step 8's `realUiLogin` returned), not the original
  // temporary one — the Maker already completed their own forced password change back in step 8,
  // and that account now has a different, real password (`makerTempPassword` no longer works).
  const makerAgainCtx = await browser.newContext();
  const makerAgainPage = await makerAgainCtx.newPage();
  await realUiLogin(makerAgainPage, state.baseURL, makerActive);
  await expect(makerAgainPage.getByRole('navigation', { name: 'Primary' }).getByRole('link', {
    name: 'Create Campaign',
  })).toHaveCount(0);

  await makerAgainPage.goto(`${state.baseURL}/campaigns/new`);
  await expect(
    makerAgainPage.getByRole('heading', { name: "You don't have access to this page" }),
  ).toBeVisible();

  await superAdminCtx.close();
  await countryAdminCtx.close();
  await tenantAdminCtx.close();
  await makerCtx.close();
  await checkerCtx.close();
  await merchantCtx.close();
  await makerAgainCtx.close();
});

/** `POST /merchants` scopes a merchant to the caller's own tenant, and `reward_config.merchants`
 * has no `tenant_id` visible on the detail screen — this reads it back via the same `GET
 * /merchants/:id` call the page itself made, so the activity fixture this step inserts directly
 * (see this spec's step 7) is bound to the right tenant. */
async function getTenantIdFromMerchant(
  page: import('@playwright/test').Page,
  apiBaseURL: string,
  merchantId: number,
): Promise<number | null> {
  const response = await page.request.get(`${apiBaseURL}/merchants/${String(merchantId)}`);
  if (!response.ok()) return null;
  const body = (await response.json()) as { data?: { tenantId?: number } };
  return body.data?.tenantId ?? null;
}
