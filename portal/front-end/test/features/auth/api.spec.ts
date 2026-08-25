import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock('../../../src/lib/apiClient', () => ({ api: { post: mockPost } }));

import {
  AUTH_ERROR_CODE,
  changePassword,
  describeAuthError,
  describeRateLimit,
  forgotPassword,
  login,
  resetPassword,
} from '../../../src/features/auth/api';
import { ApiError } from '../../../src/lib/apiError';

beforeEach(() => {
  mockPost.mockReset();
});

describe('login', () => {
  it('posts to /auth/login with exactly email and password, and parses the response', async () => {
    mockPost.mockResolvedValue({
      data: { data: { role: 'maker', mustChangePassword: false, mfaRequired: false } },
    });

    const result = await login('ada@example.com', 'correct horse battery staple 1!');

    expect(mockPost).toHaveBeenCalledWith('/auth/login', {
      email: 'ada@example.com',
      password: 'correct horse battery staple 1!',
    });
    expect(result).toEqual({ role: 'maker', mustChangePassword: false, mfaRequired: false });
  });

  it('never sends the password anywhere but the POST body (TC-19)', async () => {
    mockPost.mockResolvedValue({
      data: { data: { role: 'maker', mustChangePassword: false, mfaRequired: false } },
    });
    await login('ada@example.com', 'super-secret-value');
    const [url, body] = mockPost.mock.calls[0] as [string, unknown];
    expect(url).not.toMatch(/super-secret-value/);
    expect(url).toBe('/auth/login');
    expect(JSON.stringify(body)).toContain('super-secret-value');
  });

  it('throws an ApiError when the response does not match the expected shape', async () => {
    mockPost.mockResolvedValue({ data: { data: { role: 'maker' } } });
    await expect(login('a@b.com', 'x')).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a rejected request into an ApiError carrying the server code', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 401,
        data: {
          error: {
            code: 'AUTH_INVALID_CREDENTIALS',
            message: 'The email or password is incorrect.',
          },
        },
      },
    });
    const error = await login('a@b.com', 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(AUTH_ERROR_CODE.INVALID_CREDENTIALS);
    expect((error as ApiError).message).toBe('The email or password is incorrect.');
  });
});

describe('changePassword / forgotPassword / resetPassword', () => {
  it('changePassword posts current and new password, resolves void on 204', async () => {
    mockPost.mockResolvedValue({ data: undefined });
    await expect(changePassword('old', 'NewPassword1!')).resolves.toBeUndefined();
    expect(mockPost).toHaveBeenCalledWith('/auth/change-password', {
      currentPassword: 'old',
      newPassword: 'NewPassword1!',
    });
  });

  it('forgotPassword posts only the email', async () => {
    mockPost.mockResolvedValue({ data: undefined });
    await forgotPassword('a@b.com');
    expect(mockPost).toHaveBeenCalledWith('/auth/forgot-password', { email: 'a@b.com' });
  });

  it('resetPassword posts the token and new password', async () => {
    mockPost.mockResolvedValue({ data: undefined });
    await resetPassword('tok-123', 'NewPassword1!');
    expect(mockPost).toHaveBeenCalledWith('/auth/reset-password', {
      token: 'tok-123',
      newPassword: 'NewPassword1!',
    });
  });

  it('propagates a failure as an ApiError', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: {
            code: 'AUTH_RESET_TOKEN_INVALID',
            message: 'This link has expired or is invalid.',
          },
        },
      },
    });
    const error = await resetPassword('bad', 'NewPassword1!').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(AUTH_ERROR_CODE.RESET_TOKEN_INVALID);
  });
});

describe('describeRateLimit / describeAuthError', () => {
  it('TC-5: formats a 429 with Retry-After into a minutes message', () => {
    const error = new ApiError({
      code: 'RATE_LIMITED',
      message: 'Too many requests.',
      status: 429,
      retryAfterSeconds: 125,
    });
    expect(describeRateLimit(error)).toBe('Too many attempts, try again in 3 minutes.');
    expect(describeAuthError(error)).toBe('Too many attempts, try again in 3 minutes.');
  });

  it('uses singular "minute" for exactly one minute', () => {
    const error = new ApiError({
      code: 'RATE_LIMITED',
      message: 'x',
      status: 429,
      retryAfterSeconds: 60,
    });
    expect(describeRateLimit(error)).toBe('Too many attempts, try again in 1 minute.');
  });

  it('rounds a sub-minute wait up to at least 1 minute', () => {
    const error = new ApiError({
      code: 'RATE_LIMITED',
      message: 'x',
      status: 429,
      retryAfterSeconds: 5,
    });
    expect(describeRateLimit(error)).toBe('Too many attempts, try again in 1 minute.');
  });

  it('returns null for a non-429, and describeAuthError falls back to the server message', () => {
    const error = new ApiError({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'The email or password is incorrect.',
      status: 401,
    });
    expect(describeRateLimit(error)).toBeNull();
    expect(describeAuthError(error)).toBe('The email or password is incorrect.');
  });

  it('returns null for a 429 with no parseable Retry-After', () => {
    const error = new ApiError({
      code: 'RATE_LIMITED',
      message: 'Too many requests.',
      status: 429,
    });
    expect(describeRateLimit(error)).toBeNull();
    expect(describeAuthError(error)).toBe('Too many requests.');
  });
});
