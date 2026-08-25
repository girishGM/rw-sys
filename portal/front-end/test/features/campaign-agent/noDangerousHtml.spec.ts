/**
 * T-049 implementation note 8 — *"never render assistant output as HTML"* — asserted at the
 * **source** level, not only at the rendered-output level.
 *
 * `MessageStream.spec.tsx` proves that today's renderer escapes today's payloads. This file proves
 * something a rendering test cannot: that no file in this feature has the *capability* to inject
 * markup at all. The failure mode it guards against is a later, well-meant change — "let's support
 * bold text in replies" — which would pass every behavioural test written against plain-text
 * fixtures and reintroduce the vector for the one payload nobody thought to fixture.
 *
 * The same reasoning T-048's own report records for this hand-off: *"the renderer must not use
 * `dangerouslySetInnerHTML` — that is T-049's own DoD"*.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FEATURE_DIR = join(__dirname, '..', '..', '..', 'src', 'features', 'campaign-agent');

function featureSources(): { readonly name: string; readonly source: string }[] {
  return readdirSync(FEATURE_DIR)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => ({ name, source: readFileSync(join(FEATURE_DIR, name), 'utf8') }));
}

describe('TC-13 / TC-14 — the chat feature has no way to write markup into the DOM', () => {
  it('finds the feature’s source files (so a passing suite means something)', () => {
    const names = featureSources().map((file) => file.name);
    expect(names).toContain('MessageStream.tsx');
    expect(names).toContain('AgentChatPage.tsx');
    expect(names.length).toBeGreaterThanOrEqual(5);
  });

  it('no file uses dangerouslySetInnerHTML', () => {
    for (const { name, source } of featureSources()) {
      // The occurrences in this feature are prose in file headers explaining why it is absent;
      // an actual use is a JSX attribute, i.e. followed by `=`.
      expect(source, `${name} must not set inner HTML`).not.toMatch(/dangerouslySetInnerHTML\s*=/);
    }
  });

  it('no file writes innerHTML/outerHTML or calls insertAdjacentHTML', () => {
    for (const { name, source } of featureSources()) {
      expect(source, `${name} must not assign innerHTML`).not.toMatch(/\.innerHTML\s*=/);
      expect(source, `${name} must not assign outerHTML`).not.toMatch(/\.outerHTML\s*=/);
      expect(source, `${name} must not call insertAdjacentHTML`).not.toMatch(
        /insertAdjacentHTML\s*\(/,
      );
    }
  });

  it('no markdown or HTML-sanitiser dependency is imported — the contract is plain text', () => {
    for (const { name, source } of featureSources()) {
      expect(source, `${name} must not import a markdown renderer`).not.toMatch(
        /from '(react-)?markdown|from 'marked'|from 'dompurify'|from 'sanitize-html'/,
      );
    }
  });
});
