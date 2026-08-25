/**
 * T-050 — TC-10 (nav reorder), TC-11 (widget disable) and TC-12 (permission revoke → API 403s).
 * The Maker nav-item-disable + permission-revoke combination the golden journey's own steps
 * 12-13 exercise is not repeated here; this spec covers the three configurability mechanisms
 * Access Control offers on their own terms, on a different role, so a regression in any one of
 * the three is caught even if the golden journey's specific combination happens to mask it.
 *
 * **Serial, deliberately (T-050, 2026-08-20).** `role_nav_configs`/`role_dashboard_widgets`/
 * `role_entity_permissions` are keyed by **role**, not by tenant — every one of these three
 * tests' "Save" actions is a global write for `tenant_admin`, not scoped to `scenario`'s own
 * tenant. Running them in parallel against each other raced two "Save" round-trips against the
 * same role's config; confirmed live once the suite's other blockers (`RATE_LIMITED` et al.) no
 * longer masked it — TC-12's own permission revoke was silently not in effect by the time its API
 * call ran. `fullyParallel` still applies across *files*; this only forces the three tests inside
 * this one file to run one after another, which is sufficient because no other spec in this suite
 * writes to Access Control's role-level config.
 *
 * **`beforeAll`/`afterAll` snapshot + restore all three of `tenant_admin`'s nav/widgets/
 * permissions — found live, T-050 2026-08-21, a real, reproduced defect in this file, not the
 * product.** Exactly the same "keyed by role, not by tenant or account" fact the paragraph above
 * already states means every one of these three tests' mutations survives past this file's own
 * run, for the rest of the suite, until whatever changed it. TC-12 unchecking `merchant:create`
 * for `tenant_admin` and never restoring it was previously left in effect: any *later* spec's own
 * `tenant_admin` — including a brand new one `golden-journey.spec.ts` provisions itself — silently
 * lost the "Add merchant" button and could not create a merchant at all. Reproduced directly: a
 * full-suite run (`chromium` project, alphabetically before `golden-journey`'s own dependent
 * project — `playwright.config.ts`'s own header) hung for the full 180s on
 * `getByRole('button', { name: 'Add merchant' })`, which `MerchantsListPage.tsx` only renders when
 * `hasPermission('merchant', 'create')` is true — screenshotted mid-hang showing exactly that
 * button missing, immediately after this file's own TC-12 had unchecked it and never checked it
 * back. `golden-journey.spec.ts`'s own header already documents the identical shape for its own
 * mutation of the `maker` role (steps 12/13) and restores it the same way; this file needed the
 * same discipline and did not have it. `expectedVersion` is optimistic-concurrency (not a snapshot
 * pointer — `putPermissionsRequestSchema`'s own header), so each restore re-reads the *current*
 * version immediately before writing, the same as `golden-journey.spec.ts`'s own restore does.
 */
import { test, expect } from '../fixtures';
import { superAdminContext } from '../fixtures/superAdminSession';
import { loggedInContext } from '../fixtures/uiAuth';
import { sessionFromCookies } from '../utils/apiClient';

test.describe.configure({ mode: 'serial' });

interface NavSnapshot {
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
interface WidgetSnapshot {
  readonly version: number;
  readonly items: readonly {
    readonly widgetKey: string;
    readonly label: string;
    readonly config: Record<string, unknown>;
    readonly sortOrder: number;
    readonly enabled: boolean;
  }[];
}
interface PermissionsSnapshot {
  readonly version: number;
  readonly permissions: Record<string, readonly string[]>;
}

let originalNav: NavSnapshot | null = null;
let originalWidgets: WidgetSnapshot | null = null;
let originalPermissions: PermissionsSnapshot | null = null;

test.beforeAll(async ({ superAdminApi }) => {
  originalNav = await superAdminApi.get<NavSnapshot>('/admin/access-control/nav/tenant_admin');
  originalWidgets = await superAdminApi.get<WidgetSnapshot>(
    '/admin/access-control/widgets/tenant_admin',
  );
  originalPermissions = await superAdminApi.get<PermissionsSnapshot>(
    '/admin/access-control/permissions/tenant_admin',
  );
});

test.afterAll(async ({ superAdminApi }) => {
  if (originalNav) {
    const current = await superAdminApi.get<NavSnapshot>('/admin/access-control/nav/tenant_admin');
    await superAdminApi.put('/admin/access-control/nav/tenant_admin', {
      expectedVersion: current.version,
      items: originalNav.items,
    });
  }
  if (originalWidgets) {
    const current = await superAdminApi.get<WidgetSnapshot>(
      '/admin/access-control/widgets/tenant_admin',
    );
    await superAdminApi.put('/admin/access-control/widgets/tenant_admin', {
      expectedVersion: current.version,
      items: originalWidgets.items,
    });
  }
  if (originalPermissions) {
    const current = await superAdminApi.get<PermissionsSnapshot>(
      '/admin/access-control/permissions/tenant_admin',
    );
    await superAdminApi.put('/admin/access-control/permissions/tenant_admin', {
      expectedVersion: current.version,
      permissions: originalPermissions.permissions,
    });
  }
});

test('TC-10 — nav reorder is reflected for the target role', async ({ browser, state, scenario }) => {
  const superAdminCtx = await superAdminContext(browser, state);
  const superAdminPage = await superAdminCtx.newPage();
  await superAdminPage.goto(`${state.baseURL}/admin/access-control`);
  await superAdminPage.getByRole('tab', { name: /^Tenant Admin/ }).click();

  const items = superAdminPage.getByRole('list', { name: /Navigation items for tenant_admin/ });
  const firstLabelBefore = await items.getByRole('listitem').first().locator('input').first().inputValue();

  // Move the second item above the first.
  await items.getByRole('listitem').nth(1).getByRole('button', { name: /Move .* up/ }).click();

  const firstLabelAfter = await items.getByRole('listitem').first().locator('input').first().inputValue();
  expect(firstLabelAfter).not.toBe(firstLabelBefore);

  // Reflected for the target role: Tenant Admin's own sidebar shows the new order.
  const tenantAdminCtx = await loggedInContext(browser, state.baseURL, scenario.tenantAdmin);
  const tenantAdminPage = await tenantAdminCtx.newPage();
  await tenantAdminPage.goto(`${state.baseURL}/dashboard`);
  const nav = tenantAdminPage.getByRole('navigation', { name: 'Primary' });
  const firstNavLink = nav.getByRole('link').first();
  await expect(firstNavLink).toHaveText(firstLabelAfter);

  await superAdminCtx.close();
  await tenantAdminCtx.close();
});

test('TC-11 — widget disable removes it from that role\'s dashboard', async ({
  browser,
  state,
  scenario,
}) => {
  const superAdminCtx = await superAdminContext(browser, state);
  const superAdminPage = await superAdminCtx.newPage();
  await superAdminPage.goto(`${state.baseURL}/admin/access-control`);
  await superAdminPage.getByRole('tab', { name: /^Tenant Admin/ }).click();
  await superAdminPage.getByRole('tab', { name: 'Dashboard' }).click();

  await superAdminPage
    .getByRole('list', { name: /Dashboard widgets for tenant_admin/ })
    .getByRole('listitem')
    .filter({ hasText: 'Merchants' })
    .getByRole('switch')
    .click();
  await superAdminPage.getByRole('button', { name: 'Save dashboard' }).click();

  const tenantAdminCtx = await loggedInContext(browser, state.baseURL, scenario.tenantAdmin);
  const tenantAdminPage = await tenantAdminCtx.newPage();
  await tenantAdminPage.goto(`${state.baseURL}/dashboard`);
  // Scoped to `<main>` — the sidebar has its own, unrelated "Merchants" nav link (`role_nav_
  // configs`, a different table from the `role_dashboard_widgets` row this test disabled), and
  // that link must still be there; only the dashboard *widget* should be gone.
  await expect(tenantAdminPage.locator('main').getByText('Merchants', { exact: true })).toHaveCount(0);

  await superAdminCtx.close();
  await tenantAdminCtx.close();
});

test('TC-12 — permission revoke via Access Control makes the API call 403', async ({
  browser,
  state,
  scenario,
}) => {
  const superAdminCtx = await superAdminContext(browser, state);
  const superAdminPage = await superAdminCtx.newPage();
  await superAdminPage.goto(`${state.baseURL}/admin/access-control`);
  await superAdminPage.getByRole('tab', { name: /^Tenant Admin/ }).click();
  await superAdminPage.getByRole('tab', { name: 'Permissions' }).click();

  const merchantRow = superAdminPage
    .getByRole('row')
    .filter({ has: superAdminPage.getByRole('cell', { name: 'merchant', exact: true }) });
  await merchantRow.getByRole('checkbox', { name: 'create' }).uncheck();
  // Waited for explicitly, not just the button click, and its status checked — not just its
  // presence. `expect(...).toHaveCount(0)` below only proves no *conflict* banner appeared, which
  // is a different failure mode from the save being rejected outright. **A real, reproduced,
  // unresolved defect (T-050, 2026-08-20 — escalated per AGENT-PROTOCOL §7, not fixed here:
  // `back-end/src/modules/access-control/**` is outside this task's file scope):**
  // `PUT /admin/access-control/permissions/tenant_admin` answers 400 here, live, on an unmodified
  // real UI interaction (uncheck one checkbox, click Save) — confirmed independent of test
  // ordering (reproduces with this spec run alone, `--grep TC-12`, no other test in the process).
  // Before this status check existed, the test could not tell the save had failed at all: the
  // subsequent API call correctly stayed permitted (the change never took effect) and nothing
  // else here noticed. The status assertion below turns that same silent wrong-pass into a loud,
  // honest failure instead — restated in full in the completion report.
  const saveResponse = superAdminPage.waitForResponse(
    `${state.baseURL}/api/v1/admin/access-control/permissions/tenant_admin`,
  );
  await superAdminPage.getByRole('button', { name: 'Save permissions' }).click();
  expect((await saveResponse).status(), 'PUT permissions/tenant_admin').toBeLessThan(300);
  await expect(superAdminPage.getByText(/changed elsewhere/i)).toHaveCount(0);
  await superAdminCtx.close();

  // `sessionFromCookies`, not `login()` — reuses the one real login `buildScenario` already
  // performed for this actor (`utils/scenario.ts`'s own header) rather than a second one against
  // `LOGIN_PER_EMAIL_IP_LIMIT`.
  const tenantAdminSession = await sessionFromCookies(state.apiBaseURL, scenario.tenantAdmin.cookies);

  let status = 0;
  try {
    await tenantAdminSession.post('/merchants', {
      merchantCode: 'SHOULD-FAIL',
      name: 'Should fail',
      countryCode: scenario.country.code,
    });
  } catch (error) {
    status = (error as { status?: number }).status ?? 0;
  }
  expect(status).toBe(403);
});
