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
 */

// `vitest` runs with `process.cwd()` set to `front-end/` (the workspace package root), so
// these resolve the same way regardless of which shell directory invoked the test command.
const componentsDir = resolve(process.cwd(), 'src/components');
const tokensPath = resolve(process.cwd(), 'src/styles/tokens.css');

function parseTokens(): Record<string, string> {
  const css = readFileSync(tokensPath, 'utf8');
  const map: Record<string, string> = {};
  for (const m of css.matchAll(/--color-([a-z]+(?:-[0-9]+)?):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    map[m[1]] = m[2];
  }
  return map;
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

describe('design system — token contrast audit (TC-9, substitutes for axe-core color-contrast)', () => {
  const tokenMap = parseTokens();
  tokenMap.white = '#ffffff';

  it('parses at least the documented neutral + 5 semantic colour scales from tokens.css', () => {
    expect(Object.keys(tokenMap).length).toBeGreaterThanOrEqual(30);
  });

  const pairs = discoverPairs(tokenMap);

  it('discovers a non-trivial number of real bg/text pairs from component source', () => {
    // Sanity check that the regex extraction above isn't silently matching nothing — if this
    // ever drops to 0, the pattern broke, not the design system.
    expect(pairs.size).toBeGreaterThan(10);
  });

  for (const [label, { bg, text, source, state }] of pairs) {
    const isDisabledState = state === 'disabled';

    if (isDisabledState) {
      // WCAG 2.1 SC 1.4.3 and SC 1.4.11 both explicitly exempt inactive/disabled user
      // interface components from the contrast-ratio requirement — a disabled control is
      // deliberately rendered at reduced contrast to communicate "not operable" and is not
      // read as active content. Still assert it isn't literally invisible (ratio > 1).
      it(`${source}: ${label} — disabled state, WCAG-exempt from 4.5:1 but not invisible`, () => {
        const ratio = contrastRatio(tokenMap[bg], tokenMap[text]);
        expect(ratio, `${label} (from ${source}) measured ${ratio.toFixed(2)}:1`).toBeGreaterThan(
          1,
        );
      });
      continue;
    }

    it(`${source}: ${label} >= 4.5:1`, () => {
      const ratio = contrastRatio(tokenMap[bg], tokenMap[text]);
      expect(
        ratio,
        `${label} (from ${source}) measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});
