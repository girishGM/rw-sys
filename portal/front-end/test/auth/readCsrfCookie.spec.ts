import { afterEach, describe, expect, it } from 'vitest';
import { readCsrfCookie } from '../../src/auth/readCsrfCookie';

function setCookie(value: string) {
  document.cookie = value;
}

afterEach(() => {
  // jsdom has no `document.cookie = ''` clear-all; expire everything set by these tests.
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0]?.trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
    }
  });
});

describe('readCsrfCookie', () => {
  it('reads the rs_csrf cookie value', () => {
    setCookie('rs_csrf=abc123');
    expect(readCsrfCookie()).toBe('abc123');
  });

  it('finds rs_csrf among several cookies', () => {
    setCookie('other=1');
    setCookie('rs_csrf=xyz');
    setCookie('another=2');
    expect(readCsrfCookie()).toBe('xyz');
  });

  it('returns null when the cookie is absent', () => {
    expect(readCsrfCookie()).toBeNull();
  });

  it('URL-decodes the cookie value', () => {
    setCookie(`rs_csrf=${encodeURIComponent('a+b/c')}`);
    expect(readCsrfCookie()).toBe('a+b/c');
  });
});
