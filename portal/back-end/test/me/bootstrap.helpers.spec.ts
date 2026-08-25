/**
 * T-015 — the caching and normalisation helpers, tested as functions.
 *
 * Three small pieces of logic sit between the database and the SPA, and each has a branch that is
 * awkward to reach over HTTP and consequential when it is wrong:
 *
 *  - {@link buildBootstrapEtag} — the cache key. Get it wrong in the "too stable" direction and a
 *    revoked permission keeps being served from a browser cache (TC-13).
 *  - {@link ifNoneMatchSatisfiedBy} — the comparison. Get it wrong in the "matches too easily"
 *    direction and the same thing happens; get it wrong the other way and every revalidation
 *    downloads the whole payload, which is what the ETag exists to avoid.
 *  - {@link toWidgetConfig} — TC-11. One malformed row must not break a role's dashboard.
 */
import {
  buildBootstrapEtag,
  ifNoneMatchSatisfiedBy,
  toPermissionsDto,
  toWidgetConfig,
} from '@/modules/me/bootstrap.service';

describe('buildBootstrapEtag', () => {
  const updatedAt = new Date('2026-08-17T10:00:00.000Z');

  it('is W/"<role>-<rbacVersion>-<userUpdatedAt>" (implementation note 6)', () => {
    expect(buildBootstrapEtag('maker', 3, updatedAt)).toBe(`W/"maker-3-${updatedAt.getTime()}"`);
  });

  it('changes when the rbac version changes — the whole invalidation mechanism', () => {
    expect(buildBootstrapEtag('maker', 3, updatedAt)).not.toBe(
      buildBootstrapEtag('maker', 4, updatedAt),
    );
  });

  it('changes when the user row changes, so PATCH /me is visible to the caller at once', () => {
    expect(buildBootstrapEtag('maker', 3, updatedAt)).not.toBe(
      buildBootstrapEtag('maker', 3, new Date(updatedAt.getTime() + 1000)),
    );
  });

  it('differs between two roles at the same version — no cross-role cache hit', () => {
    expect(buildBootstrapEtag('maker', 3, updatedAt)).not.toBe(
      buildBootstrapEtag('checker', 3, updatedAt),
    );
  });

  it('is stable for the same inputs', () => {
    expect(buildBootstrapEtag('maker', 3, updatedAt)).toBe(
      buildBootstrapEtag('maker', 3, updatedAt),
    );
  });

  it('degrades to 0 rather than throwing on a null timestamp', () => {
    expect(buildBootstrapEtag('maker', 3, null)).toBe('W/"maker-3-0"');
  });

  it('degrades to 0 for undefined and for an invalid Date', () => {
    expect(buildBootstrapEtag('maker', 3, undefined)).toBe('W/"maker-3-0"');
    expect(buildBootstrapEtag('maker', 3, new Date('nonsense'))).toBe('W/"maker-3-0"');
  });
});

describe('ifNoneMatchSatisfiedBy', () => {
  const etag = 'W/"maker-3-1000"';

  it('is false when the header is absent — an unconditional GET always gets a body', () => {
    expect(ifNoneMatchSatisfiedBy(undefined, etag)).toBe(false);
  });

  it('is false for an empty or whitespace header', () => {
    expect(ifNoneMatchSatisfiedBy('', etag)).toBe(false);
    expect(ifNoneMatchSatisfiedBy('   ', etag)).toBe(false);
  });

  it('matches the exact weak tag the server sent', () => {
    expect(ifNoneMatchSatisfiedBy(etag, etag)).toBe(true);
  });

  it('matches the same tag sent strongly — If-None-Match compares weakly (RFC 7232 §3.2)', () => {
    // A proxy or a client library is free to drop the `W/` prefix. Comparing the opaque tag only
    // is what the RFC requires for this header, and refusing the match would mean re-sending the
    // whole payload to a client that already has it.
    expect(ifNoneMatchSatisfiedBy('"maker-3-1000"', etag)).toBe(true);
  });

  it('matches one entry of a comma-separated list, with whitespace', () => {
    expect(ifNoneMatchSatisfiedBy('W/"other", W/"maker-3-1000" , W/"third"', etag)).toBe(true);
  });

  it('matches * — the client holds some version and asks only for a changed one', () => {
    expect(ifNoneMatchSatisfiedBy('*', etag)).toBe(true);
    expect(ifNoneMatchSatisfiedBy('  *  ', etag)).toBe(true);
  });

  it('does NOT match a different version — TC-13, the case that must return fresh data', () => {
    expect(ifNoneMatchSatisfiedBy('W/"maker-2-1000"', etag)).toBe(false);
  });

  it('does NOT match another role’s tag at the same version', () => {
    expect(ifNoneMatchSatisfiedBy('W/"checker-3-1000"', etag)).toBe(false);
  });

  it('does NOT match on a prefix or a substring', () => {
    // `"maker-3-1000"` contains `"maker-3-100`; a `startsWith`/`includes` implementation would
    // serve a 304 to a client holding a genuinely older revision.
    expect(ifNoneMatchSatisfiedBy('W/"maker-3-100"', etag)).toBe(false);
    expect(ifNoneMatchSatisfiedBy('W/"maker"', etag)).toBe(false);
    expect(ifNoneMatchSatisfiedBy('W/"maker-3-10000"', etag)).toBe(false);
  });

  it('does not match an empty list element', () => {
    expect(ifNoneMatchSatisfiedBy(',', etag)).toBe(false);
  });
});

describe('toWidgetConfig — TC-11', () => {
  it('passes an object through unchanged', () => {
    expect(toWidgetConfig({ type: 'kpi', span: 2 })).toEqual({ type: 'kpi', span: 2 });
  });

  it('returns {} for null, which is what an empty column parses to', () => {
    expect(toWidgetConfig(null)).toEqual({});
  });

  it('returns {} for the {} the model getter already produces from malformed JSON', () => {
    // `parseJsonColumn` (T-003) is the first line: `not json` → `{}`. This asserts the second
    // line does not then undo it.
    expect(toWidgetConfig({})).toEqual({});
  });

  it('returns {} for valid JSON that is not an object — a scalar or an array', () => {
    // These are the ones the model getter lets through: `5`, `"kpi"` and `[1,2]` all parse.
    // Reaching the SPA as `config`, each would break a dashboard for every user of that role.
    expect(toWidgetConfig(5)).toEqual({});
    expect(toWidgetConfig('kpi')).toEqual({});
    expect(toWidgetConfig([1, 2])).toEqual({});
    expect(toWidgetConfig(true)).toEqual({});
    expect(toWidgetConfig(undefined)).toEqual({});
  });
});

describe('toPermissionsDto', () => {
  it('flattens the matrix to { entity: actions[] } (implementation note 3)', () => {
    const map = new Map<string, ReadonlySet<string>>([
      ['campaign', new Set(['view', 'create', 'update'])],
      ['rule', new Set(['view'])],
    ]);

    expect(toPermissionsDto(map)).toEqual({
      campaign: ['view', 'create', 'update'],
      rule: ['view'],
    });
  });

  it('orders entities alphabetically, for a reproducible payload', () => {
    const map = new Map<string, ReadonlySet<string>>([
      ['rule', new Set(['view'])],
      ['audit', new Set(['view'])],
      ['campaign', new Set(['view'])],
    ]);

    expect(Object.keys(toPermissionsDto(map))).toEqual(['audit', 'campaign', 'rule']);
  });

  it('keeps the authored action order rather than re-sorting it', () => {
    const map = new Map<string, ReadonlySet<string>>([
      ['campaign', new Set(['view', 'create', 'update', 'submit'])],
    ]);

    expect(toPermissionsDto(map).campaign).toEqual(['view', 'create', 'update', 'submit']);
  });

  it('returns {} for a role granted nothing', () => {
    expect(toPermissionsDto(new Map())).toEqual({});
  });

  it('copies the sets — a caller cannot mutate the cached matrix through the response', () => {
    const actions = new Set(['view']);
    const map = new Map<string, ReadonlySet<string>>([['campaign', actions]]);

    const dto = toPermissionsDto(map);
    (dto.campaign as string[]).push('delete');

    expect([...actions]).toEqual(['view']);
  });
});
