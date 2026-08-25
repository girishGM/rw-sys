/**
 * T-021 — one-off, real-browser verification helper for Verification steps 4 and 6
 * (Storybook must already be running at http://localhost:6006, see `npm run storybook`).
 *
 * This is NOT part of the vitest/jsdom suite (jsdom has no real layout engine, so it
 * cannot answer "does this overflow at 360px" or "does Tab move real, visible focus"
 * honestly) and is NOT picked up by `npm test`/`npm run test:cov` — it is a standalone
 * script run via `npm run verify:manual`, using the same real Chromium that
 * `npm run test:a11y` already installs via the `playwright:install` script.
 *
 * Not a replacement for an actual human keyboard/visual pass — see the T-021 completion
 * report for exactly what this does and does not establish.
 */
import { chromium } from 'playwright';

const BASE = process.env.STORYBOOK_URL ?? 'http://localhost:6006';

async function main() {
  const browser = await chromium.launch();

  // --- Verification step 6: resize to 360px, check for horizontal overflow on every story ---
  const indexRes = await fetch(`${BASE}/index.json`);
  const index = await indexRes.json();
  const stories = Object.values(index.entries ?? index.stories ?? {}).filter(
    (e) => e.type === 'story',
  );

  const page360 = await browser.newPage({ viewport: { width: 360, height: 800 } });
  const overflowing = [];
  for (const s of stories) {
    await page360.goto(`${BASE}/iframe.html?id=${s.id}&viewMode=story`, {
      waitUntil: 'networkidle',
    });
    const { scrollWidth, clientWidth } = await page360.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    if (scrollWidth > clientWidth + 1) {
      overflowing.push({ id: s.id, scrollWidth, clientWidth });
    }
  }
  await page360.close();

  console.log(`\n=== Verification step 6: 360px width, ${stories.length} stories ===`);
  if (overflowing.length === 0) {
    console.log('PASS: zero stories overflow horizontally at 360px width');
  } else {
    console.log('FAIL:', JSON.stringify(overflowing, null, 2));
  }

  // --- Verification step 4: keyboard-only pass over a representative sample ---
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = [];

  async function tabSequence(storyId, presses) {
    await page.goto(`${BASE}/iframe.html?id=${storyId}&viewMode=story`, {
      waitUntil: 'networkidle',
    });
    await page.evaluate(() => document.body.focus());
    const seen = [];
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const hasVisibleFocusStyle =
          style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
            ? true
            : style.boxShadow !== 'none';
        return {
          tag: el.tagName,
          label: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40),
          visible: rect.width > 0 && rect.height > 0,
          hasVisibleFocusStyle,
        };
      });
      seen.push(info);
    }
    return seen;
  }

  results.push({ story: 'Button/Primary', tabs: await tabSequence('design-system-button--primary', 3) });
  results.push({ story: 'Input/Default', tabs: await tabSequence('design-system-input--default', 2) });

  // Modal harness (Modal.stories.tsx) renders with the dialog already `open`, behind an
  // "Open modal" trigger button underneath — so on mount, focus should already be inside
  // the dialog (Radix's default open-focus behaviour), Tab should stay trapped inside it,
  // and Escape should close it and return focus to the "Open modal" trigger.
  await page.goto(`${BASE}/iframe.html?id=design-system-modal--default&viewMode=story`, {
    waitUntil: 'networkidle',
  });
  const focusInsideOnMount = await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"]');
    return !!(modal && document.activeElement && modal.contains(document.activeElement));
  });
  // Tab repeatedly (more than the number of focusable elements inside the dialog) and
  // confirm focus never escapes the dialog — that's what "trapped" means.
  let staysTrapped = true;
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"]');
      return !!(modal && document.activeElement && modal.contains(document.activeElement));
    });
    if (!inside) staysTrapped = false;
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const dialogClosedOnEscape = await page.evaluate(
    () => document.querySelector('[role="dialog"]') === null,
  );
  const focusReturnsToTriggerOnEscape = await page.evaluate(
    () => (document.activeElement?.textContent ?? '').includes('Open modal'),
  );
  results.push({
    story: 'Modal/Default',
    focusInsideOnMount,
    tabStaysTrappedInsideDialog: staysTrapped,
    dialogClosedOnEscape,
    focusReturnsToTriggerOnEscape,
  });

  await page.close();
  await browser.close();

  console.log('\n=== Verification step 4: keyboard-only pass (representative sample) ===');
  console.log(JSON.stringify(results, null, 2));

  process.exit(overflowing.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
