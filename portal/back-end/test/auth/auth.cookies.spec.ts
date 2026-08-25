/**
 * T-011 — cookie attribute strings and cookie-header parsing (TC-1…TC-4).
 *
 * These assertions look pedantic on purpose. Every one of them is a property a browser enforces
 * and a server can silently get wrong: a missing `Secure` makes the `__Host-` prefix invalid and
 * the cookie is dropped entirely; an `httpOnly` on `rs_csrf` makes the SPA unable to read it and
 * every mutating request fail CSRF; a mismatched `Path` on the clear header means logout does not
 * log anyone out. None of those produces a stack trace.
 */
import {
  ACCESS_COOKIE,
  ALL_AUTH_COOKIES,
  CSRF_COOKIE,
  REFRESH_COOKIE,
  buildClearCookie,
  buildSetCookie,
  readCookie,
} from '@/modules/auth/auth.cookies';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  ROOT_COOKIE_PATH,
} from '@/modules/auth/session.constants';

describe('cookie definitions (02-SECURITY §1)', () => {
  it('TC-2: __Host-rs_at is HttpOnly, Secure, SameSite=Strict, Path=/, 15 minutes', () => {
    const header = buildSetCookie(ACCESS_COOKIE, 'the.access.token');

    expect(header).toBe(
      `__Host-rs_at=the.access.token; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ACCESS_TOKEN_TTL_SECONDS}`,
    );
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
  });

  it('TC-3: __Host-rs_rt satisfies the __Host- prefix rules and lives seven days', () => {
    const header = buildSetCookie(REFRESH_COOKIE, 'opaque-refresh');

    expect(header).toBe(
      `__Host-rs_rt=opaque-refresh; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`,
    );
    expect(REFRESH_COOKIE.path).toBe(ROOT_COOKIE_PATH);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it('TC-4: rs_csrf is Secure and SameSite=Strict but deliberately NOT HttpOnly', () => {
    const header = buildSetCookie(CSRF_COOKIE, 'csrf-value');

    expect(header).toBe(
      `rs_csrf=csrf-value; Secure; SameSite=Strict; Path=/; Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`,
    );
    expect(header).not.toContain('HttpOnly');
  });

  /**
   * T-058 regression. The defect this replaces was not "the refresh cookie has the wrong path"
   * in isolation — it was that nothing anywhere asserted the *rule* linking a cookie's name to
   * the attributes that name obliges it to carry. TC-3 asserted a literal `Path=/api/v1/auth`,
   * so it agreed with the code and both were wrong together.
   *
   * This derives the requirement from the name instead: any cookie called `__Host-*`, including
   * one added years from now, must satisfy RFC 6265bis §4.1.3 or the browser silently refuses to
   * store it. No unit test can observe that refusal — `curl` and `supertest` replay whatever
   * `Set-Cookie` says — so the rule has to be asserted directly, on both the set and the clear
   * header (a clear header that violates it fails to clear anything).
   */
  it('every __Host--prefixed cookie satisfies RFC 6265bis §4.1.3 (Secure, Path=/, no Domain)', () => {
    const hostCookies = ALL_AUTH_COOKIES.filter((c) => c.name.startsWith('__Host-'));

    // Guards the guard: if a rename ever drops the prefix, this test must not quietly pass by
    // iterating an empty list.
    expect(hostCookies.map((c) => c.name)).toEqual(['__Host-rs_at', '__Host-rs_rt']);

    for (const cookie of hostCookies) {
      expect(cookie.path).toBe('/');

      for (const header of [buildSetCookie(cookie, 'x'), buildClearCookie(cookie)]) {
        expect(header).toContain('; Secure;');
        expect(header).not.toMatch(/domain=/i);

        // Parse the attribute rather than substring-matching it: `toContain('Path=/')` is
        // satisfied by `Path=/api/v1/auth` too, so the literal form of this check would have
        // passed against the very defect it exists to catch.
        const path = /(?:^|;\s*)Path=([^;]*)/i.exec(header)?.[1];
        expect(path).toBe('/');
      }
    }
  });

  it('never emits a Domain attribute — a __Host- cookie carrying one is rejected outright', () => {
    for (const cookie of ALL_AUTH_COOKIES) {
      expect(buildSetCookie(cookie, 'x')).not.toMatch(/domain=/i);
      expect(buildClearCookie(cookie)).not.toMatch(/domain=/i);
    }
  });

  it('marks every cookie Secure, in every environment, with no conditional', () => {
    for (const cookie of ALL_AUTH_COOKIES) {
      expect(buildSetCookie(cookie, 'x')).toContain('; Secure;');
    }
  });

  it('percent-encodes a value that would otherwise break the header', () => {
    expect(buildSetCookie(ACCESS_COOKIE, 'a b;c=d')).toContain('__Host-rs_at=a%20b%3Bc%3Dd;');
  });
});

describe('clearing cookies (implementation note 9)', () => {
  it('clears with attributes matching the setter exactly, or the cookie survives', () => {
    for (const cookie of ALL_AUTH_COOKIES) {
      const set = buildSetCookie(cookie, 'value');
      const cleared = buildClearCookie(cookie);

      // Everything except the value and the lifetime must be byte-identical.
      const attributesOf = (header: string) =>
        header
          .split('; ')
          .slice(1)
          .filter((part) => !part.startsWith('Max-Age') && !part.startsWith('Expires'));

      expect(attributesOf(cleared)).toEqual(attributesOf(set));
    }
  });

  it('uses both Max-Age=0 and an Expires in the past', () => {
    const cleared = buildClearCookie(REFRESH_COOKIE);

    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(cleared.startsWith('__Host-rs_rt=;')).toBe(true);
  });
});

describe('readCookie', () => {
  it('reads a named cookie out of a multi-cookie header', () => {
    const header = 'other=1; __Host-rs_at=abc.def.ghi; rs_csrf=zzz';

    expect(readCookie(header, '__Host-rs_at')).toBe('abc.def.ghi');
    expect(readCookie(header, 'rs_csrf')).toBe('zzz');
  });

  it('decodes percent-encoded values', () => {
    expect(readCookie('rs_csrf=a%20b', 'rs_csrf')).toBe('a b');
  });

  it('takes the first occurrence, as a browser does, so a later one cannot shadow it', () => {
    expect(readCookie('__Host-rs_at=first; __Host-rs_at=second', '__Host-rs_at')).toBe('first');
  });

  it.each([
    ['an absent header', undefined, 'rs_csrf'],
    ['an empty header', '', 'rs_csrf'],
    ['a name that is not present', 'a=1; b=2', 'rs_csrf'],
    ['a segment with no equals sign', 'flagonly', 'flagonly'],
    ['an empty value', 'rs_csrf=', 'rs_csrf'],
    ['an invalid percent escape', 'rs_csrf=%E0%A4%A', 'rs_csrf'],
  ])('returns null for %s', (_label, header, name) => {
    expect(readCookie(header, name)).toBeNull();
  });

  it('tolerates surrounding whitespace, which real clients send', () => {
    expect(readCookie('  a=1 ;  rs_csrf = value  ', 'rs_csrf')).toBe('value');
  });
});
