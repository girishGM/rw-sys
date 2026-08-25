import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock('../../../src/lib/apiClient', () => ({ api: { post: mockPost } }));

import { MFA_ERROR_CODE, enrolMfa, recoverMfa, verifyMfa } from '../../../src/features/auth/mfaApi';
import { ApiError } from '../../../src/lib/apiError';

beforeEach(() => {
  mockPost.mockReset();
});

describe('enrolMfa', () => {
  it('posts to /auth/mfa/enrol with an empty body and no pending token field (R5)', async () => {
    mockPost.mockResolvedValue({
      data: {
        data: {
          secret: 'ABCD1234EFGH5678IJKL',
          otpauthUri: 'otpauth://totp/Reward%20Portal:admin@x.com?secret=ABCD',
          issuer: 'Reward Portal',
          account: 'admin@x.com',
          algorithm: 'SHA1',
          digits: 6,
          periodSeconds: 30,
        },
      },
    });

    const offer = await enrolMfa();

    expect(mockPost).toHaveBeenCalledWith('/auth/mfa/enrol', {});
    const [, body] = mockPost.mock.calls[0] as [string, unknown];
    expect(body).not.toHaveProperty('mfaPendingToken');
    expect(offer).toEqual({
      secret: 'ABCD1234EFGH5678IJKL',
      otpauthUri: 'otpauth://totp/Reward%20Portal:admin@x.com?secret=ABCD',
      issuer: 'Reward Portal',
      account: 'admin@x.com',
      algorithm: 'SHA1',
      digits: 6,
      periodSeconds: 30,
    });
  });

  it('TC-2: maps a 403 MFA_ALREADY_ENROLLED into an ApiError carrying that code', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 403,
        data: { error: { code: 'MFA_ALREADY_ENROLLED', message: 'Already enrolled.' } },
      },
    });

    const error = await enrolMfa().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).code).toBe(MFA_ERROR_CODE.ALREADY_ENROLLED);
  });

  it('TC-12: maps a 401 AUTH_SESSION_INVALID (dead pending token) into an ApiError', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 401,
        data: { error: { code: 'AUTH_SESSION_INVALID', message: 'Session invalid.' } },
      },
    });

    const error = await enrolMfa().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).code).toBe(MFA_ERROR_CODE.SESSION_INVALID);
  });

  it('throws an ApiError when the response does not match the expected shape', async () => {
    mockPost.mockResolvedValue({ data: { data: { secret: 'x' } } });
    await expect(enrolMfa()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('verifyMfa', () => {
  it('posts only totpCode to /auth/mfa/verify, no pending token field (R5)', async () => {
    mockPost.mockResolvedValue({
      data: { data: { role: 'super_admin', mustChangePassword: false, mfaRequired: false } },
    });

    await verifyMfa('123456');

    expect(mockPost).toHaveBeenCalledWith('/auth/mfa/verify', { totpCode: '123456' });
  });

  it('TC-6: an ordinary challenge success carries no recoveryCodes', async () => {
    mockPost.mockResolvedValue({
      data: { data: { role: 'super_admin', mustChangePassword: false, mfaRequired: false } },
    });

    const result = await verifyMfa('123456');
    expect(result).toEqual({
      role: 'super_admin',
      mustChangePassword: false,
      recoveryCodes: undefined,
      recoveryCodesRemaining: undefined,
    });
  });

  it('TC-1: an enrolment-completing success carries the ten recovery codes', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `CODE-${i}-XXXX`);
    mockPost.mockResolvedValue({
      data: {
        data: {
          role: 'super_admin',
          mustChangePassword: false,
          mfaRequired: false,
          recoveryCodes: codes,
        },
      },
    });

    const result = await verifyMfa('123456');
    expect(result.recoveryCodes).toEqual(codes);
  });

  it('TC-5: a wrong code maps to a 401 AUTH_INVALID_CREDENTIALS ApiError', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 401,
        data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials.' } },
      },
    });

    const error = await verifyMfa('000000').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('TC-9: a 429 carries retryAfterSeconds through to the ApiError', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 429,
        headers: { 'retry-after': '900' },
        data: { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } },
      },
    });

    const error = await verifyMfa('123456').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(429);
    expect((error as ApiError).retryAfterSeconds).toBe(900);
  });
});

describe('recoverMfa', () => {
  it('posts only recoveryCode to /auth/mfa/recover, no pending token field (R5)', async () => {
    mockPost.mockResolvedValue({
      data: {
        data: {
          role: 'super_admin',
          mustChangePassword: false,
          mfaRequired: false,
          recoveryCodesRemaining: 9,
        },
      },
    });

    await recoverMfa('ABCD-EFGH-JKMN');

    expect(mockPost).toHaveBeenCalledWith('/auth/mfa/recover', { recoveryCode: 'ABCD-EFGH-JKMN' });
  });

  it('TC-11: a successful recovery carries recoveryCodesRemaining and no recoveryCodes', async () => {
    mockPost.mockResolvedValue({
      data: {
        data: {
          role: 'super_admin',
          mustChangePassword: false,
          mfaRequired: false,
          recoveryCodesRemaining: 9,
        },
      },
    });

    const result = await recoverMfa('ABCD-EFGH-JKMN');
    expect(result.recoveryCodesRemaining).toBe(9);
    expect(result.recoveryCodes).toBeUndefined();
  });

  it('TC-8: a spent/unknown recovery code maps to a 401 AUTH_INVALID_CREDENTIALS ApiError', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 401,
        data: { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials.' } },
      },
    });

    const error = await recoverMfa('DEAD-CODE-0000').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('AUTH_INVALID_CREDENTIALS');
  });
});
