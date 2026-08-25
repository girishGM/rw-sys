/**
 * T-018 — path normalisation and the always-cleartext list (TC-9, TC-10).
 *
 * This is the one place a mistake is silent in the *dangerous* direction: a route that should be
 * cleartext but is not simply breaks, loudly, on the first request. A route that should be
 * encrypted but is treated as cleartext keeps working perfectly and ships plaintext. So the list
 * is asserted in both directions.
 */
import {
  ALWAYS_CLEARTEXT_EXACT,
  ALWAYS_CLEARTEXT_PREFIXES,
  isAlwaysCleartext,
  normalisePath,
  SESSION_KID_PREFIX,
  sessionKid,
  TRANSPORT_ERROR_CODE,
} from '@/common/transport-crypto/transport-crypto.constants';
import { SAFE_ERROR_CODE_PATTERN } from '@/common/errors/app-error';

describe('normalisePath', () => {
  it.each([
    ['/api/v1/auth/login', '/auth/login'],
    ['/auth/login', '/auth/login'],
    ['/API/V1/Auth/Login', '/auth/login'],
    ['/api/v1/auth/login/', '/auth/login'],
    ['/api/v1/campaigns///', '/campaigns'],
    ['/api/v1', '/'],
    ['/api/v1/', '/'],
    ['/', '/'],
    // Not the global prefix — a route that merely starts with the same letters must survive.
    ['/api/v10/things', '/api/v10/things'],
  ])('%s → %s', (input, expected) => {
    expect(normalisePath(input)).toBe(expected);
  });
});

describe('isAlwaysCleartext', () => {
  it.each([
    '/api/v1/auth/login',
    '/api/v1/auth/refresh',
    '/api/v1/auth/forgot-password',
    '/api/v1/auth/reset-password',
    '/api/v1/health',
    '/api/v1/health/ready',
    '/health',
    '/api/v1/auth/login/',
  ])('%s is cleartext', (path) => {
    expect(isAlwaysCleartext(path)).toBe(true);
  });

  it.each([
    '/api/v1/auth/change-password',
    '/api/v1/auth/logout',
    '/api/v1/auth/sessions',
    '/api/v1/users',
    '/api/v1/campaigns',
    '/api/v1/me/bootstrap',
    // A route whose name merely begins with a cleartext one's must NOT be exempt.
    '/api/v1/healthcheck',
  ])('%s is not cleartext', (path) => {
    expect(isAlwaysCleartext(path)).toBe(false);
  });

  it('matches the four routes the design document enumerates, and no others', () => {
    // 07-DATA-PROTECTION.md §5: "Login, refresh, forgot-password and health stay in cleartext".
    // The task file adds reset-password. Pinned so a fifth cannot be added without a review.
    expect([...ALWAYS_CLEARTEXT_EXACT]).toEqual([
      '/auth/login',
      '/auth/refresh',
      '/auth/forgot-password',
      '/auth/reset-password',
    ]);
    expect([...ALWAYS_CLEARTEXT_PREFIXES]).toEqual(['/health']);
  });
});

describe('sessionKid', () => {
  it('is `sess_` + the session id (07-DATA-PROTECTION.md §5)', () => {
    expect(sessionKid('9f2a')).toBe('sess_9f2a');
    expect(SESSION_KID_PREFIX).toBe('sess_');
  });
});

describe('TRANSPORT_ERROR_CODE', () => {
  it('PAYLOAD_DECRYPT_FAILED is a code the error filter will serialise', () => {
    // T-014's `SAFE_ERROR_CODE_PATTERN` is the gate every code must pass to reach a client.
    expect(SAFE_ERROR_CODE_PATTERN.test(TRANSPORT_ERROR_CODE.PAYLOAD_DECRYPT_FAILED)).toBe(true);
    expect(TRANSPORT_ERROR_CODE.PAYLOAD_DECRYPT_FAILED).toBe('PAYLOAD_DECRYPT_FAILED');
  });
});
