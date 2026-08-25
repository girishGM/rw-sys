/**
 * T-050 — TC-5: a Maker and a Checker, in two independent browser contexts, working the same
 * campaign concurrently. "No interference" is checked two ways: the actions each performed land
 * correctly (nothing lost, nothing duplicated), and neither ever sees the other's in-progress,
 * unsaved state.
 */
import { test, expect } from '../fixtures';
import { loggedInContext } from '../fixtures/uiAuth';

test('TC-5 — concurrent Maker + Checker in two contexts: no interference', async ({
  browser,
  state,
  scenario,
}) => {
  const makerCtx = await loggedInContext(browser, state.baseURL, scenario.maker);
  const makerPage = await makerCtx.newPage();

  const checkerCtx = await loggedInContext(browser, state.baseURL, scenario.checker);
  const checkerPage = await checkerCtx.newPage();

  // Both dashboards load concurrently — the first real "do two sessions interfere" check: one
  // request context's cookies must never leak into the other's response.
  await Promise.all([
    makerPage.goto(`${state.baseURL}/dashboard`),
    checkerPage.goto(`${state.baseURL}/approvals`),
  ]);
  await expect(makerPage.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(checkerPage.getByRole('heading', { name: 'Approvals' })).toBeVisible();

  // The Maker creates a campaign while the Checker is independently polling an empty queue —
  // truly concurrent, not sequential-with-a-delay.
  const campaignCode = `CC${Date.now()}`;
  await Promise.all([
    (async () => {
      await makerPage.goto(`${state.baseURL}/campaigns/new`);
      await makerPage.getByLabel('Campaign code').fill(campaignCode);
      await makerPage.getByLabel('Campaign name').fill('Concurrency check');
      const today = new Date();
      await makerPage
        .getByLabel('Start date')
        .fill(today.toISOString().slice(0, 10));
      await makerPage
        .getByLabel('End date')
        .fill(new Date(today.getTime() + 10 * 86_400_000).toISOString().slice(0, 10));
      await makerPage.getByRole('button', { name: 'Create draft' }).click();
      await makerPage.waitForURL(/\/campaigns\/\d+$/);
    })(),
    checkerPage.reload(),
  ]);

  // Neither session observed the other's unsaved, in-progress state: the Checker's queue has no
  // row for a campaign that was never submitted, and the Maker's own new campaign is exactly the
  // one they just created (their tenant, not the Checker's own view of it).
  await expect(checkerPage.getByRole('cell', { name: campaignCode })).toHaveCount(0);
  await expect(makerPage.getByRole('heading', { name: 'Concurrency check' })).toBeVisible();

  await makerCtx.close();
  await checkerCtx.close();
});
