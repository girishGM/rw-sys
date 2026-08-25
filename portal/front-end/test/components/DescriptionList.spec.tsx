import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DescriptionList, DescriptionItem } from '../../src/components/DescriptionList';

/**
 * T-063 — Detail-view `<dt>` labels fail WCAG AA contrast (2.56:1 against a required 4.5:1).
 *
 * Per AGENT-PROTOCOL.md §3 ("assert the observable property, not the implementation string"):
 * these tests compute the real WCAG 2.1 §1.4.3 relative-luminance contrast ratio from the
 * *actual* hex values in `tokens.css` rather than asserting a class-name string — a class name
 * being "text-slate-600" cannot itself prove anything about contrast if the token it resolves
 * to were ever redefined.
 */

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

function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];
  return (lighter + 0.05) / (darker + 0.05);
}

const tokensCss = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

function token(name: string): string {
  const m = tokensCss.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!m) throw new Error(`token --color-${name} not found in tokens.css`);
  return m[1];
}

describe('T-063 — <dt> label contrast', () => {
  const white = '#ffffff';

  it('TC-7 (regression guard): text-slate-400 on white is the real, measured failure this task fixes', () => {
    // Documents *why* the fix exists — if this ever stops failing on its own (e.g. someone
    // redefines slate-400 itself), the premise of the override below no longer holds and this
    // test should be revisited, not silently left passing for the wrong reason.
    const ratio = contrastRatio(token('slate-400'), white);
    expect(ratio).toBeLessThan(4.5);
  });

  it('TC-3: slate-600 (the shared <dt> convention colour) on a white card is >= 4.5:1', () => {
    const ratio = contrastRatio(token('slate-600'), white);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('the global override in tokens.css maps every tag carrying text-slate-400 to the same accessible colour', () => {
    // Regression guard for the mechanism itself (AGENT-PROTOCOL R9: the failing screens live
    // under src/features/**, outside this task's file scope, so the fix has to work as a
    // global override rather than a per-screen edit — see tokens.css's T-063 comment). The
    // override lists several tags (dt, dd, p, span, li, tr, th, td) sharing one declaration
    // block, each ending in `[class~='text-slate-400']`.
    const block = tokensCss.match(
      /((?:[a-z]+\[class~=['"]text-slate-400['"]\],?\s*)+)\{\s*color:\s*var\(--color-([a-z]+-[0-9]+)\)/,
    );
    expect(block).not.toBeNull();
    const [, selectorList, overriddenTo] = block ?? [];
    for (const tag of ['dt', 'p', 'span', 'tr', 'td']) {
      expect(selectorList, `expected a ${tag}[class~='text-slate-400'] selector`).toContain(
        `${tag}[class~=`,
      );
    }
    const ratio = contrastRatio(token(overriddenTo), white);
    expect(
      ratio,
      `text-slate-400 override resolves to --color-${overriddenTo}`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('TC-6: DescriptionList/DescriptionItem render the term/detail pair with hierarchy intact', () => {
    render(
      <DescriptionList>
        <DescriptionItem term="Contact email" detail="admin@example.com" />
      </DescriptionList>,
    );
    const term = screen.getByText('Contact email');
    const detail = screen.getByText('admin@example.com');
    expect(term.tagName).toBe('DT');
    expect(detail.tagName).toBe('DD');
    // The label is visually smaller/uppercase (secondary) and the value is the plain-cased,
    // larger sibling (primary) — hierarchy is expressed through weight/case/size, not colour
    // alone, so darkening the label's colour for contrast doesn't erase that hierarchy.
    expect(term.className).toContain('uppercase');
    expect(term.className).toContain('text-xs');
    expect(detail.className).not.toContain('uppercase');
  });

  it('DescriptionItem never reintroduces the failing slate-400 <dt> colour', () => {
    render(
      <DescriptionList>
        <DescriptionItem term="Status" detail="Active" />
      </DescriptionList>,
    );
    const term = screen.getByText('Status');
    expect(term.className).not.toContain('text-slate-400');
  });
});
