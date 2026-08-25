/**
 * T-022 — `lib/csrf.ts` in isolation. The end-to-end "is the header actually attached"
 * behaviour is asserted against the real interceptor chain in `apiClient.spec.ts` (TC-1,
 * TC-2, TC-3); this file is the unit-level cases for the two pure functions underneath it.
 */
import { describe, expect, it } from 'vitest';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  readCsrfToken,
  requiresCsrfHeader,
} from '../../src/lib/csrf';

describe('readCsrfToken', () => {
  it('reads the value when the cookie is present on its own', () => {
    expect(readCsrfToken('rs_csrf=abc123')).toBe('abc123');
  });

  it('reads the value when other cookies surround it', () => {
    expect(readCsrfToken('other=1; rs_csrf=abc123; another=2')).toBe('abc123');
  });

  it('decodes a percent-encoded value', () => {
    expect(readCsrfToken('rs_csrf=abc%2Fdef%3D')).toBe('abc/def=');
  });

  it('returns null when the cookie is not present', () => {
    expect(readCsrfToken('other=1; another=2')).toBeNull();
  });

  it('returns null for an empty cookie jar', () => {
    expect(readCsrfToken('')).toBeNull();
  });

  it('does not match a cookie whose name merely ends with rs_csrf', () => {
    expect(readCsrfToken('not_rs_csrf=abc123')).toBeNull();
  });

  it('defaults to document.cookie when no argument is given', () => {
    document.cookie = 'rs_csrf=from-document';
    expect(readCsrfToken()).toBe('from-document');
    document.cookie = 'rs_csrf=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
  });
});

describe('requiresCsrfHeader', () => {
  it.each(['get', 'GET', 'head', 'HEAD', 'options', 'OPTIONS'])(
    'TC-1 — %s does not require the header',
    (method) => {
      expect(requiresCsrfHeader(method)).toBe(false);
    },
  );

  it.each(['post', 'POST', 'put', 'PUT', 'patch', 'PATCH', 'delete', 'DELETE'])(
    'TC-2 — %s requires the header',
    (method) => {
      expect(requiresCsrfHeader(method)).toBe(true);
    },
  );

  it('treats an absent method as GET (axios default)', () => {
    expect(requiresCsrfHeader(undefined)).toBe(false);
  });
});

describe('constants', () => {
  it('names match the server-side contract (02-SECURITY.md §4)', () => {
    expect(CSRF_COOKIE_NAME).toBe('rs_csrf');
    expect(CSRF_HEADER_NAME).toBe('X-CSRF-Token');
  });
});
