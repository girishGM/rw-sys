/**
 * T-050 — TC-2: the same campaign's dates, displayed identically under two different browser
 * timezones. Implementation note 6: *"campaign date bugs live exactly here."*
 *
 * Two `BrowserContext`s in the same test, one `timezoneId: 'UTC'` and one
 * `timezoneId: 'Asia/Kolkata'` — Playwright's own mechanism for controlling a page's timezone
 * (the `Intl`/`Date` a page's JS engine sees), which is the layer that actually matters here:
 * `formatDay` in `ReviewStep.tsx` calls `new Date(iso).toLocaleDateString()`, i.e. the *browser's*
 * timezone, not the Node process running the test. Verification step 4
 * (`TZ=UTC npm run e2e -- --grep golden`) additionally proves the suite's own Node-side date
 * arithmetic (picking "today"/"+30 days" for the campaign's own start/end) is not itself
 * timezone-sensitive — this spec does not depend on `process.env.TZ` at all, by design, so it
 * passes identically regardless of what invoked it with.
 *
 * **Reads the Review step, not `/campaigns/:id` directly — found live, T-050 2026-08-20.**
 * `CampaignDetailPage.tsx`'s own header: *"a draft opens straight into the wizard instead — an
 * editable campaign has no meaningful [read-only] detail view... anything past draft is
 * read-only."* A freshly created campaign (this spec never submits it) is always still `draft`,
 * so `/campaigns/:id` always lands back in `CampaignWizardPage` at step 1 (Basics), never on the
 * "–"-joined date range this file used to look for — that text only exists on the read-only
 * detail view a draft can never reach. `ReviewStep.tsx` (step 7 of the same wizard, reachable for
 * a draft too — `CampaignWizardPage.tsx`'s own header: *"the wizard does not block navigation on
 * incomplete steps"*) renders the same `formatDay`-driven dates this TC actually cares about,
 * joined with "to" instead — this is what the comment above already named as the target; only the
 * page this file actually read from was wrong.
 */
import { test, expect } from '../fixtures';
import { loggedInContext } from '../fixtures/uiAuth';

test('TC-2 — golden-journey-style campaign dates render identically under UTC and Asia/Kolkata', async ({
  browser,
  state,
  scenario,
}) => {
  // `playwright.config.ts`'s default (`timeout: 60_000`) is sized for an ordinary, single-screen
  // spec; this one does two real logins, a real campaign create, and two full wizard traversals to
  // Review (5 "Next" clicks for the freshly created draft, 6 for the plain page reload — see
  // `advanceWizardToReview`'s own header) — 11+ real, unmocked network round trips in one test.
  // Found live (T-050, 2026-08-21): a full run reliably reaches Review on *both* passes (confirmed
  // from the failure's own page snapshot — Next disabled, step 7 "current step", i.e. the wizard
  // got there) but still trips the 60s budget, purely on wall time, exactly the same "budget
  // problem, not a hang" shape `golden-journey.spec.ts`'s own `test.setTimeout(180_000)` documents
  // for the same reason. 120s is generous headroom for this spec's own, smaller amount of real work
  // (two role logins and one campaign, not `golden-journey.spec.ts`'s full six-role delegation
  // chain) without masking a genuine hang.
  test.setTimeout(120_000);

  // One campaign, created once, through the real Maker UI under a fixed timezone context.
  // `loggedInContext`'s own `contextOptions` parameter carries `timezoneId` straight through to
  // `browser.newContext()` — the cached session (if any) is reused either way; the timezone is
  // independent of the session.
  const makerCtxUtc = await loggedInContext(browser, state.baseURL, scenario.maker, {
    timezoneId: 'UTC',
  });
  const page = await makerCtxUtc.newPage();

  await page.goto(`${state.baseURL}/campaigns/new`);
  const campaignCode = `TZ${Date.now()}`;
  await page.getByLabel('Campaign code').fill(campaignCode);
  await page.getByLabel('Campaign name').fill('Timezone check');
  const start = '2027-01-15';
  const end = '2027-02-15';
  await page.getByLabel('Start date').fill(start);
  await page.getByLabel('End date').fill(end);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.waitForURL(/\/campaigns\/\d+$/);
  const campaignId = page.url().split('/').pop();

  // `ReviewStep.tsx`'s `formatDay` renders `new Date(iso).toLocaleDateString()` — the
  // browser-local, timezone-sensitive formatting this TC exists to pin down. Reachable from a
  // draft by advancing the wizard's own step state (`CampaignWizardPage.tsx`'s "Next" button,
  // never blocked on incomplete steps): Basics (already saved above) → Merchants → Journey →
  // Rules → Rewards → Budgets → Review, the same five-click path `golden-journey.spec.ts` uses.
  await advanceWizardToReview(page);
  const utcDates = await readDisplayedDateRange(page);
  await makerCtxUtc.close();

  const makerCtxIst = await loggedInContext(browser, state.baseURL, scenario.maker, {
    timezoneId: 'Asia/Kolkata',
  });
  const istPage = await makerCtxIst.newPage();
  await istPage.goto(`${state.baseURL}/campaigns/${String(campaignId)}`);
  await advanceWizardToReview(istPage);
  const istDates = await readDisplayedDateRange(istPage);
  await makerCtxIst.close();

  expect(istDates).toBe(utcDates);
  expect(utcDates).toContain('2027');
  expect(campaignCode.length).toBeGreaterThan(0);
});

/**
 * Whatever step `CampaignWizardPage.tsx` currently sits on through to Review (its last step, 7 of
 * 7), clicking "Next" without filling anything else — the wizard does not gate navigation on step
 * completeness, and this TC only needs Review's own `formatDay`-rendered date line, not a
 * complete, submittable campaign.
 *
 * Not a fixed click count: the first page (fresh off `POST /campaigns`) already auto-advances to
 * step 2 (`CampaignWizardPage.tsx`'s own `setStep(1)` after a successful create), needing 5 more
 * "Next" clicks to reach Review; the *second* page in this TC (a plain `page.goto` of the same
 * now-existing campaign) mounts at step 1 (Basics) like any fresh load, needing 6.
 *
 * **Not `nextButton.isDisabled()`, and not "wait for the step text to stop being what it was
 * either — found live, T-050 2026-08-21, a real hang, reproduced deterministically across four
 * separate runs (60s and 120s budgets, `isDisabled()`- and `not.toHaveText()`-driven loops alike).
 *
 * `isDisabled()` version: `.click()` resolves as soon as the click event dispatches, before React
 * has necessarily committed the resulting re-render, so the very next `isDisabled()` call can read
 * the *pre-click* DOM once too often, decide the (about-to-be-disabled) Review-step button is
 * still clickable, and issue one extra click at the exact moment it genuinely does become
 * `disabled` — Playwright's click-actionability retry then waits out the rest of the test budget
 * on an element that will never become clickable again.
 *
 * `not.toHaveText(previousLabel)` version (the first attempted fix, also reproduced hanging):
 * `Stepper.tsx` keys each `<li>` on its own `step.label`, so moving `aria-current="step"` from one
 * step to the next is (at least) two separate DOM writes — the old `<li>` loses the attribute, the
 * new one gains it — not one atomic swap. A negated assertion is satisfied by the locator matching
 * *zero* elements just as much as by it matching a different value, so
 * `expect(locator).not.toHaveText(label)` can resolve **true** during the zero-width window where
 * neither `<li>` currently carries `aria-current="step"`, before the new one actually gets it —
 * confirmed directly from a trace: `not.toHaveText` reported success, and the very next
 * `innerText()` read the *same* step label as before the click, six clicks in.
 *
 * Fixed by asserting the **specific next label** the click is supposed to produce, from this
 * file's own known copy of `CampaignWizardPage.tsx`'s `STEPS` order — a positive assertion, which
 * (unlike a negated one) cannot be satisfied by the element momentarily not matching at all; it
 * keeps polling until the *correct* step's `<li>` genuinely carries the attribute.
 */
const WIZARD_STEP_LABELS = ['Basics', 'Merchants', 'Journey', 'Rules', 'Rewards', 'Budgets', 'Review'];

async function advanceWizardToReview(page: import('@playwright/test').Page): Promise<void> {
  const currentStepIndicator = page.locator('[aria-current="step"]');
  const initialLabel = await currentStepIndicator.innerText();
  let index = WIZARD_STEP_LABELS.findIndex((label) => initialLabel.includes(label));
  if (index === -1) {
    throw new Error(`Could not match the wizard's current step against a known label: "${initialLabel}"`);
  }
  while (WIZARD_STEP_LABELS[index] !== 'Review') {
    const nextLabel = WIZARD_STEP_LABELS[index + 1];
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(currentStepIndicator).toContainText(nextLabel);
    index += 1;
  }
}

async function readDisplayedDateRange(page: import('@playwright/test').Page): Promise<string> {
  // `ReviewStep.tsx`: `Code <strong>{code}</strong> · {formatDay(start)} to {formatDay(end)}`.
  // Anchored on `^Code ` rather than the bare substring " to " — this campaign is deliberately
  // left incomplete (no merchants/journey/rules/rewards/budgets, none of which this TC needs),
  // so `ReviewStep.tsx`'s own "Not ready to submit (…)" issues banner is showing too, and that
  // sentence *also* contains " to " ("Not ready **to** submit") — found live, matched that banner
  // instead on the first version of this fix. `^Code ` is unique to the one line this TC actually
  // wants.
  const description = page.getByText(/^Code /).first();
  await description.waitFor({ state: 'visible' });
  return description.innerText();
}
