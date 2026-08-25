import { describe, expect, it } from 'vitest';
import { DEFAULT_NEXT_PATH, buildLoginRedirect, resolveNextPath } from '../../src/auth/nextPath';

describe('resolveNextPath', () => {
  it('TC-5: returns a genuine in-app relative path unchanged', () => {
    expect(resolveNextPath('/campaigns')).toBe('/campaigns');
  });

  it('TC-6: rejects an absolute URL to another origin (open redirect)', () => {
    expect(resolveNextPath('https://evil.com')).toBe(DEFAULT_NEXT_PATH);
  });

  it('TC-6: rejects an absolute URL even to a path that looks safe', () => {
    expect(resolveNextPath('https://evil.com/dashboard')).toBe(DEFAULT_NEXT_PATH);
  });

  it('TC-7: rejects a protocol-relative URL', () => {
    expect(resolveNextPath('//evil.com')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects a backslash-based protocol-relative bypass', () => {
    expect(resolveNextPath('/\\evil.com')).toBe(DEFAULT_NEXT_PATH);
  });

  it('falls back to the default when next is missing or empty', () => {
    expect(resolveNextPath(null)).toBe(DEFAULT_NEXT_PATH);
    expect(resolveNextPath(undefined)).toBe(DEFAULT_NEXT_PATH);
    expect(resolveNextPath('')).toBe(DEFAULT_NEXT_PATH);
  });

  it('rejects a bare relative path with no leading slash', () => {
    expect(resolveNextPath('campaigns')).toBe(DEFAULT_NEXT_PATH);
  });

  it('preserves query string and hash on a safe path', () => {
    expect(resolveNextPath('/campaigns?status=draft#top')).toBe('/campaigns?status=draft#top');
  });
});

describe('buildLoginRedirect', () => {
  it('TC-1: encodes the intended path into next exactly as the guard chain expects', () => {
    expect(buildLoginRedirect('/dashboard', '')).toBe('/login?next=%2Fdashboard');
  });

  it('includes the query string in the encoded value', () => {
    expect(buildLoginRedirect('/campaigns', '?status=draft')).toBe(
      `/login?next=${encodeURIComponent('/campaigns?status=draft')}`,
    );
  });
});
