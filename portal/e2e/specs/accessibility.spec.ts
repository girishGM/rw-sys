/**
 * T-050 — TC-6: `@axe-core/playwright` against every major, reachable-without-deep-setup screen.
 * Tagged `@a11y` so `npm run e2e:a11y` (verification step 5) can select just this file.
 *
 * Screens that need a live entity (a specific rule/campaign id, and so on) are visited through
 * `scenario`'s own ids rather than a magic `1` — a real id that actually renders the screen's
 * full content (a table with rows, a form with values) is a stronger a11y check than an empty
 * "not found" state would be.
 */
import { test, expect } from '../fixtures';
import AxeBuilder from '@axe-core/playwright';
import { superAdminContext } from '../fixtures/superAdminSession';
import { loggedInContext } from '../fixtures/uiAuth';
import type { Page } from '@playwright/test';

async function assertNoViolations(page: Page, screenName: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(results.violations, `${screenName}: ${JSON.stringify(results.violations, null, 2)}`).toEqual(
    [],
  );
}

test.describe('TC-6 @a11y — zero axe violations per screen', () => {
  test('super_admin screens', async ({ browser, state, scenario }) => {
    const ctx = await superAdminContext(browser, state);
    const page = await ctx.newPage();

    const screens: [string, string][] = [
      ['dashboard', '/dashboard'],
      ['countries list', '/countries'],
      ['country detail', `/countries/${String(scenario.country.id)}`],
      ['rules list', '/rules'],
      ['rule detail', `/rules/${String(scenario.rule.id)}`],
      ['rewards list', '/rewards'],
      ['reward detail', `/rewards/${String(scenario.reward.id)}`],
      ['tenants list', '/tenants'],
      ['tenant detail', `/tenants/${String(scenario.tenant.id)}`],
      ['access control', '/admin/access-control'],
      ['audit log', '/audit'],
    ];
    for (const [name, path] of screens) {
      await page.goto(`${state.baseURL}${path}`);
      await assertNoViolations(page, name);
    }
    await ctx.close();
  });

  test('login and password screens', async ({ page, state }) => {
    await page.goto(`${state.baseURL}/login`);
    await assertNoViolations(page, 'login');

    await page.goto(`${state.baseURL}/forgot-password`);
    await assertNoViolations(page, 'forgot password');
  });

  test('tenant-scoped screens', async ({ browser, state, scenario }) => {
    const ctx = await loggedInContext(browser, state.baseURL, scenario.tenantAdmin);
    const page = await ctx.newPage();

    const screens: [string, string][] = [
      ['users list', '/users'],
      ['merchants list', '/merchants'],
      ['merchant detail', `/merchants/${String(scenario.merchant.id)}`],
      ['campaigns list', '/campaigns'],
      ['new campaign', '/campaigns/new'],
    ];
    for (const [name, path] of screens) {
      await page.goto(`${state.baseURL}${path}`);
      await assertNoViolations(page, name);
    }
    await ctx.close();
  });

  test('checker and merchant screens', async ({ browser, state, scenario }) => {
    const checkerCtx = await loggedInContext(browser, state.baseURL, scenario.checker);
    const checkerPage = await checkerCtx.newPage();
    await checkerPage.goto(`${state.baseURL}/approvals`);
    await assertNoViolations(checkerPage, 'approvals queue');
    await checkerCtx.close();

    const merchantCtx = await loggedInContext(browser, state.baseURL, scenario.merchantUser);
    const merchantPage = await merchantCtx.newPage();
    await merchantPage.goto(`${state.baseURL}/merchant/campaigns`);
    await assertNoViolations(merchantPage, 'merchant campaigns');
    await merchantCtx.close();
  });
});
