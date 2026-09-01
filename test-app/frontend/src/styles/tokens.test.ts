/**
 * T-005 — TC-1/TC-2/TC-3: every token value in `tokens.css` matches UI-UX-DESIGN.md's token
 * table *exactly*, for all 3 themes. Asserted against the raw CSS text (read directly via
 * `node:fs`, not a bundler import — Vite's own `*.css?raw` suffix was tried first but,
 * empirically, resolves to an empty string for `.css` specifically under this workspace's
 * Vite 6 / Vitest 3 combination, unlike every other extension; plain `fs.readFileSync` reads
 * the real file with no transform pipeline involved at all) rather than a browser-computed
 * style: jsdom (this workspace's `vitest` environment) does not run a real layout/paint
 * pipeline, so `getComputedStyle` can't be trusted to reflect an external stylesheet's cascade
 * the way a real browser would — reading the actual declaration text is the one thing here that
 * can't silently pass with the wrong value.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `vitest run`'s cwd is this workspace root (`frontend/`) — resolving from there rather than
// `import.meta.url` sidesteps that URL not always being a real `file://` URL under this
// workspace's Vite 6 / Vitest 3 transform pipeline.
const tokensCss = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf-8');

type Theme = 'bright' | 'midnight' | 'celebration';

/** Pulls the declaration block for `[data-theme="theme"] { ... }` out of the raw stylesheet —
 * works regardless of what else that selector is grouped with (Bright's own block is grouped
 * with `:root`). */
function themeBlock(theme: Theme): string {
  const marker = `[data-theme='${theme}']`;
  const markerIndex = tokensCss.indexOf(marker);
  expect(markerIndex, `expected to find a ${marker} selector in tokens.css`).toBeGreaterThan(-1);
  const openBrace = tokensCss.indexOf('{', markerIndex);
  const closeBrace = tokensCss.indexOf('}', openBrace);
  return tokensCss.slice(openBrace + 1, closeBrace);
}

function tokenValue(block: string, name: string): string {
  const re = new RegExp(`--${name}:\\s*([^;]+);`);
  const match = block.match(re);
  expect(match, `expected --${name} to be declared`).not.toBeNull();
  return match![1].trim();
}

// UI-UX-DESIGN.md's own token table, copied verbatim.
const EXPECTED: Record<Theme, Record<string, string>> = {
  bright: {
    'bg-base': 'oklch(97.6% 0.01 85)',
    surface: 'oklch(100% 0 0 / .72)',
    'surface-2': 'oklch(95% 0.014 85)',
    border: 'oklch(100% 0 0 / .8)',
    text: 'oklch(20% 0.02 260)',
    'text-muted': 'oklch(45% 0.02 260)',
    accent: 'oklch(60% 0.15 165)',
    'accent-strong': 'oklch(47% 0.16 165)',
    'accent-soft': 'oklch(92% 0.06 165)',
    secondary: 'oklch(58% 0.14 290)',
    warn: 'oklch(68% 0.18 45)',
    'warn-strong': 'oklch(50% 0.18 40)',
  },
  midnight: {
    'bg-base': 'oklch(13.5% 0.025 275)',
    surface: 'oklch(28% 0.03 270 / .55)',
    'surface-2': 'oklch(32% 0.035 270 / .8)',
    border: 'oklch(100% 0 0 / .1)',
    text: 'oklch(95% 0.01 260)',
    'text-muted': 'oklch(70% 0.02 260)',
    accent: 'oklch(78% 0.15 195)',
    'accent-strong': 'oklch(86% 0.13 195)',
    'accent-soft': 'oklch(32% 0.09 195 / .6)',
    secondary: 'oklch(76% 0.16 320)',
    warn: 'oklch(78% 0.15 55)',
    'warn-strong': 'oklch(84% 0.13 50)',
  },
  celebration: {
    'bg-base': 'oklch(17% 0.05 300)',
    surface: 'oklch(30% 0.05 300 / .5)',
    'surface-2': 'oklch(33% 0.06 300 / .8)',
    border: 'oklch(100% 0 0 / .1)',
    text: 'oklch(96% 0.012 300)',
    'text-muted': 'oklch(80% 0.03 300)',
    accent: 'oklch(83% 0.16 85)',
    'accent-strong': 'oklch(88% 0.13 85)',
    'accent-soft': 'oklch(34% 0.09 85 / .6)',
    secondary: 'oklch(72% 0.21 340)',
    warn: 'oklch(78% 0.17 40)',
    'warn-strong': 'oklch(84% 0.14 40)',
  },
};

describe.each(Object.keys(EXPECTED) as Theme[])('tokens.css [data-theme="%s"]', (theme) => {
  const block = themeBlock(theme);
  const expected = EXPECTED[theme];

  it.each(Object.entries(expected))('--%s matches UI-UX-DESIGN.md exactly', (name, value) => {
    expect(tokenValue(block, name)).toBe(value);
  });
});

describe('tokens.css structure', () => {
  it('Bright is the default theme (`:root` shares its block, no data-theme attribute needed)', () => {
    const rootBlockIndex = tokensCss.indexOf(":root,\n[data-theme='bright']");
    expect(rootBlockIndex).toBeGreaterThan(-1);
  });

  it('defines the shared glass/gradient-mesh classes every theme re-styles for free', () => {
    expect(tokensCss).toContain('.glass {');
    expect(tokensCss).toContain('.gradient-mesh-bg {');
    expect(tokensCss).toContain('@supports not');
  });
});
