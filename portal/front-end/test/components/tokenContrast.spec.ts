import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-021 — retry 1/3 addition (2026-08-18).
 *
 * TC-9 ("contrast audit of every token pair in use — all >= 4.5:1") was previously satisfied
 * only by four pairs computed by hand and pasted into the completion report as prose — the
 * review correctly did not accept that as equivalent to a machine-checked gate. `axe-core`
 * cannot be installed in this sandbox (no network access), but the WCAG 2.1 §1.4.3
 * relative-luminance contrast formula needs nothing but arithmetic, and every colour this
 * design system can ever render lives in exactly one place, `src/styles/tokens.css` (TC-16
 * enforces that no component may hard-code a hex value). So instead of a curated, hand-picked
 * list, this test:
 *
 *  1. Parses every `--color-*` custom property straight out of `tokens.css` (the real source
 *     of truth, not a hand-copied mirror that could drift from it).
 *  2. Scans every component source file (excluding stories/tests) for `bg-{color}-{shade}` /
 *     `text-{color}-{shade|white}` Tailwind utility tokens that co-occur in the same class
 *     string — this is how every component in this library actually pairs a background with
 *     its text (see `StatusPill`/`Badge`/`Button`), so a shared string is a reliable signal
 *     they render on the same element. Pseudo-state prefixes (`hover:`, `disabled:`, etc.)
 *     are resolved against the base (unprefixed) colour for whichever side (bg or text) isn't
 *     itself overridden for that state, matching how the cascade actually resolves it.
 *  3. Computes the real contrast ratio for every distinct pair discovered this way and asserts
 *     it is >= 4.5:1.
 *
 * This is not a substitute for axe-core running against real rendered CSS (it can't catch a
 * contrast bug introduced by, say, an opacity utility stacked on top of a token), but it is a
 * genuine, automated, self-updating check against the actual token values and actual class
 * strings shipped in this PR — strictly more rigorous than the prose table it replaces.
 *
 * ---
 *
 * T-129 retry 1/3 fix (2026-08-29). This file previously parsed `tokens.css` with a single
 * whole-file regex (`css.matchAll(...)`), so once T-129 added the `[data-theme='yellow-black']`
 * and `[data-theme='red-white']` override blocks below the `:root` block, every `--color-*`
 * name that a theme block redeclares silently resolved to *whichever declaration is textually
 * last in the file* — i.e. this test was actually auditing one chimera palette (`:root`'s
 * declarations overwritten by `yellow-black`'s, which are in turn overwritten by `red-white`'s
 * for every name `red-white` also redeclares) that no running theme ever renders, not each of
 * the three real themes independently, even though `tokens.css`'s own T-129 header comment
 * claimed the latter. There is nothing wrong with the actual palette values (a corrected,
 * per-theme run below passes with 0 failures), but the automated regression guard the comment
 * promised did not exist until this fix.
 *
 * Fixed by parsing each CSS block *structurally* (brace-matched, not a single flat regex over
 * the whole file) into three separate maps — `:root` (the base/`light-blue` palette, since
 * `light-blue` has no override block of its own — see `tokens.css`'s own T-129 header), plus
 * one override map per `[data-theme='...']` block — then resolving each theme as
 * `{ ...base, ...thatTheme'sOwnOverrides }` (never cascading through another theme's block, the
 * way the browser itself never does: only one `data-theme` attribute is ever present on
 * `<html>` at a time). The bg/text pair *discovery* pass over component source only needs to
 * run once — theme blocks only ever redefine values for token *names* the `:root` block already
 * declares (enforced by `tokens.css`'s own T-129 header, "never a new token name"), so the set
 * of pairs a component can render is identical across all three themes; only the contrast
 * assertion below is re-run per theme, against that theme's own resolved value for each token.
 */

// `vitest` runs with `process.cwd()` set to `front-end/` (the workspace package root), so
// these resolve the same way regardless of which shell directory invoked the test command.
const componentsDir = resolve(process.cwd(), 'src/components');
const tokensPath = resolve(process.cwd(), 'src/styles/tokens.css');

/**
 * Extracts the `--color-*` declarations from exactly one CSS block, matched *structurally*
 * (find the selector, then walk brace depth to that block's own closing `}`) rather than with
 * a single regex over the whole file — see this file's own T-129 header for why a flat,
 * whole-file regex silently produced a last-declaration-wins chimera once more than one block
 * existed. Returns `{}` if `selectorRegex` doesn't match anywhere (e.g. a theme that, like
 * `light-blue`, deliberately has no override block).
 */
function parseBlock(css: string, selectorRegex: RegExp): Record<string, string> {
  const selectorMatch = selectorRegex.exec(css);
  if (!selectorMatch) return {};

  const braceStart = css.indexOf('{', selectorMatch.index);
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd === -1) {
    throw new Error(`unbalanced braces parsing ${tokensPath} from selector ${selectorRegex}`);
  }

  const block = css.slice(braceStart + 1, braceEnd);
  const map: Record<string, string> = {};
  for (const m of block.matchAll(/--color-([a-z]+(?:-[0-9]+)?):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    map[m[1]] = m[2];
  }
  return map;
}

/**
 * Resolves the actual, rendered `--color-*` map for every named theme this design system
 * ships (`ThemeSwitcher.tsx`'s own theme list — kept in sync by inspection since that file is
 * outside this task's owned paths). Each theme is `{ ...base, ...itsOwnOverrides }` only —
 * never cascaded through a sibling theme's block, matching how `data-theme` actually resolves
 * in the browser.
 */
function parseThemedTokens(): Record<string, Record<string, string>> {
  const css = readFileSync(tokensPath, 'utf8');
  const base = parseBlock(css, /:root\s*\{/);
  const yellowBlack = parseBlock(css, /\[data-theme=['"]yellow-black['"]\]\s*\{/);
  const redWhite = parseBlock(css, /\[data-theme=['"]red-white['"]\]\s*\{/);

  return {
    'light-blue': { ...base },
    'yellow-black': { ...base, ...yellowBlack },
    'red-white': { ...base, ...redWhite },
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** WCAG 2.1 §1.4.3 contrast ratio between two hex colours. */
function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];
  return (lighter + 0.05) / (darker + 0.05);
}

interface ColourToken {
  prefix: string;
  kind: 'bg' | 'text';
  key: string; // e.g. "primary-600" or "white"
}

const TOKEN_PATTERN = /(?:([\w-]+):)?(bg|text)-([a-z]+)(?:-([0-9]+))?\b/g;

interface DiscoveredPair {
  bg: string;
  text: string;
  source: string;
  state: string;
}

function discoverPairs(tokenMap: Record<string, string>): Map<string, DiscoveredPair> {
  const pairs = new Map<string, DiscoveredPair>();
  const files = readdirSync(componentsDir).filter(
    (f) => f.endsWith('.tsx') && !f.endsWith('.stories.tsx'),
  );

  for (const file of files) {
    const src = readFileSync(`${componentsDir}/${file}`, 'utf8');
    // Every quoted string literal (className groups are always written as one string in
    // this codebase — see cx() calls throughout src/components).
    const strings = [...src.matchAll(/(['`])((?:(?!\1).)*)\1/g)].map((m) => m[2]);

    for (const str of strings) {
      if (!/\bbg-|\btext-/.test(str)) continue;
      TOKEN_PATTERN.lastIndex = 0;
      const entries: ColourToken[] = [];
      for (const m of str.matchAll(TOKEN_PATTERN)) {
        const key = m[4] ? `${m[3]}-${m[4]}` : m[3];
        if (!tokenMap[key] && key !== 'white') continue;
        entries.push({ prefix: m[1] ?? '', kind: m[2] as 'bg' | 'text', key });
      }
      const bgs = entries.filter((e) => e.kind === 'bg');
      const texts = entries.filter((e) => e.kind === 'text');
      if (bgs.length === 0 || texts.length === 0) continue;

      const baseBg = bgs.find((e) => e.prefix === '');
      const baseText = texts.find((e) => e.prefix === '');
      const states = new Set([...bgs, ...texts].map((e) => e.prefix));

      for (const state of states) {
        const bg = bgs.find((e) => e.prefix === state) ?? baseBg;
        const text = texts.find((e) => e.prefix === state) ?? baseText;
        if (!bg || !text) continue;
        const key = `${bg.key} bg / ${text.key} text (${state || 'base'})`;
        if (!pairs.has(key)) {
          pairs.set(key, { bg: bg.key, text: text.key, source: file, state });
        }
      }
    }
  }
  return pairs;
}

const themedTokens = parseThemedTokens();
const THEME_NAMES = Object.keys(themedTokens) as (keyof typeof themedTokens)[];

describe('design system — token contrast audit (TC-9, substitutes for axe-core color-contrast)', () => {
  it('parses at least the documented neutral + 5 semantic colour scales from tokens.css', () => {
    expect(Object.keys(themedTokens['light-blue']).length).toBeGreaterThanOrEqual(30);
  });

  it('resolves 3 named themes, and every theme redefines only pre-existing token names', () => {
    // T-129's own tokens.css header: theme blocks may only redefine values for token *names*
    // the `:root` block already declares, never introduce a new one — enforced here so a
    // future theme addition can't silently add a token name only that theme's components can
    // safely use (which would break "no per-component change" the moment another theme is
    // selected).
    expect(THEME_NAMES.sort()).toEqual(['light-blue', 'red-white', 'yellow-black']);
    const baseKeys = new Set(Object.keys(themedTokens['light-blue']));
    for (const theme of THEME_NAMES) {
      for (const key of Object.keys(themedTokens[theme])) {
        expect(baseKeys.has(key), `${theme} introduced a new token name: ${key}`).toBe(true);
      }
    }
  });

  // Pair *discovery* (which bg/text token names actually co-occur in component source) is
  // theme-independent — see this file's own T-129 header — so it only needs to run once,
  // against any theme's key set (they're all identical; only the values differ).
  const discoveryTokenMap: Record<string, string> = {
    ...themedTokens['light-blue'],
    white: '#ffffff',
  };
  const pairs = discoverPairs(discoveryTokenMap);

  it('discovers a non-trivial number of real bg/text pairs from component source', () => {
    // Sanity check that the regex extraction above isn't silently matching nothing — if this
    // ever drops to 0, the pattern broke, not the design system.
    expect(pairs.size).toBeGreaterThan(10);
  });

  for (const theme of THEME_NAMES) {
    const tokenMap: Record<string, string> = { ...themedTokens[theme], white: '#ffffff' };

    describe(`theme: ${theme}`, () => {
      for (const [label, { bg, text, source, state }] of pairs) {
        const isDisabledState = state === 'disabled';

        if (isDisabledState) {
          // WCAG 2.1 SC 1.4.3 and SC 1.4.11 both explicitly exempt inactive/disabled user
          // interface components from the contrast-ratio requirement — a disabled control is
          // deliberately rendered at reduced contrast to communicate "not operable" and is not
          // read as active content. Still assert it isn't literally invisible (ratio > 1).
          it(`${source}: ${label} — disabled state, WCAG-exempt from 4.5:1 but not invisible`, () => {
            const ratio = contrastRatio(tokenMap[bg], tokenMap[text]);
            expect(
              ratio,
              `[${theme}] ${label} (from ${source}) measured ${ratio.toFixed(2)}:1`,
            ).toBeGreaterThan(1);
          });
          continue;
        }

        it(`${source}: ${label} >= 4.5:1`, () => {
          const ratio = contrastRatio(tokenMap[bg], tokenMap[text]);
          expect(
            ratio,
            `[${theme}] ${label} (from ${source}) measured ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
    });
  }
});
