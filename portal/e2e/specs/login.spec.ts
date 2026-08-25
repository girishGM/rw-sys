/**
 * T-050 — implementation note 3: *"the login spec itself must log in for real, since login is
 * the thing under test."* Every other spec's `realUiLogin` reuses this exact same flow, but this
 * file is where a genuine login (wrong password, then correct) is the point of the test, not
 * incidental setup.
 *
 * `super_admin` is deliberately absent from the per-role table below — not because the SPA cannot
 * complete that role's login (T-060 closed that gap; see `global-setup.ts`'s own header), but
 * because `bootstrap-superadmin.ts` refuses a second `super_admin` outright, so there is exactly
 * one real "first login" for that role in the entire run. `global-setup.ts` spends it, through a
 * real headless browser, before any spec (this one included) exists to spend it again.
 */
import { test, expect } from '../fixtures';
import { ApiSession, login } from '../utils/apiClient';
import { uniqueEmail, uniqueTag } from '../utils/ids';

test('wrong password: generic error, password field cleared, email preserved', async ({
  page,
  state,
  scenario,
}) => {
  await page.goto(`${state.baseURL}/login`);
  await page.getByLabel('Email').fill(scenario.tenantAdmin.email);
  await page.getByLabel('Password').fill('definitely-wrong-password');
  await page.getByRole('button', { name: 'Log in' }).click();

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue(scenario.tenantAdmin.email);
  await expect(page.getByLabel('Password')).toHaveValue('');
});

test('unknown email produces the identical generic error (anti-enumeration)', async ({
  page,
  state,
}) => {
  await page.goto(`${state.baseURL}/login`);
  await page.getByLabel('Email').fill('nobody-at-all@e2e.invalid');
  await page.getByLabel('Password').fill('whatever-password-12');
  await page.getByRole('button', { name: 'Log in' }).click();
  const wrongEmailMessage = await page.getByRole('alert').innerText();

  await page.getByLabel('Password').fill('another-wrong-one-12');
  await page.getByRole('button', { name: 'Log in' }).click();
  const wrongPasswordMessage = await page.getByRole('alert').innerText();

  expect(wrongEmailMessage).toBe(wrongPasswordMessage);
});

test('Maker: first real login is forced through /change-password, then reaches /dashboard', async ({
  page,
  state,
  scenario,
  request,
}) => {
  // `scenario.maker` was already activated by `utils/scenario.ts` (via the API), so every other
  // spec gets a usable session without re-running this exact flow — this test's own point is the
  // *first* real, browser-driven login, so it creates one genuinely fresh, still-temporary-
  // password Maker of its own rather than reusing `scenario`'s already-activated one.
  const tenantAdminSession = new ApiSession(request, state.apiBaseURL);
  await login(tenantAdminSession, scenario.tenantAdmin.email, scenario.tenantAdmin.password);
  const freshEmail = uniqueEmail('fresh-maker');
  // `fresh.email` is deliberately never read below — see `utils/scenario.ts`'s header, "bug 2":
  // `POST /users` currently echoes the new user's email back as ciphertext, not the plaintext
  // `freshEmail` this call just submitted. This test is about the first-login/forced-
  // change-password flow, not about what `POST /users` echoes, so using the already-known-good
  // local value changes nothing about what it asserts.
  const fresh = await tenantAdminSession.post<{ email: string; temporaryPassword: string }>('/users', {
    email: freshEmail,
    displayName: `Fresh maker ${uniqueTag('LOGIN')}`,
    role: 'maker',
  });

  await page.goto(`${state.baseURL}/login`);
  await page.getByLabel('Email').fill(freshEmail);
  await page.getByLabel('Password').fill(fresh.temporaryPassword);
  await page.getByRole('button', { name: 'Log in' }).click();

  await page.waitForURL((url) => url.pathname === '/change-password');
  await page.getByLabel('Current password').fill(fresh.temporaryPassword);
  await page.getByLabel('New password', { exact: true }).fill('Fresh-Maker-9-Password!');
  await page.getByLabel('Confirm new password').fill('Fresh-Maker-9-Password!');
  await page.getByRole('button', { name: 'Change password' }).click();

  await page.waitForURL((url) => url.pathname === '/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // T-058 TC-3 (inherited acceptance criterion, `T-050-e2e-tests.md`'s "Inherited acceptance
  // criteria" table) — only a real browser's own cookie jar can prove this: neither `curl` nor
  // `supertest` enforce the `__Host-` prefix rules that silently dropped this exact cookie before
  // T-058 (`auth.cookies.ts`'s own header, "Do not narrow this back to `/api/v1/auth`").
  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => cookie.name === '__Host-rs_rt')).toBe(true);
});
