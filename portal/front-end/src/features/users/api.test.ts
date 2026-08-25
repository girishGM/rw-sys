import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { User, UserWithTemporaryPassword } from '@reward-portal/shared';

const { mockGet, mockPost, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('../../lib/apiClient', () => ({
  api: { get: mockGet, post: mockPost, patch: mockPatch },
}));

import {
  createUser,
  deactivateUser,
  fetchUser,
  fetchUsers,
  resetUserPassword,
  updateUser,
  userQueryKey,
  usersQueryKey,
} from './api';
import { ApiError } from '../../lib/apiError';

const user: User = {
  id: 500,
  email: 'maker@example.invalid',
  displayName: 'A Maker',
  role: 'maker',
  countryId: 1,
  tenantId: 10,
  merchantId: null,
  status: 'active',
  mustChangePassword: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const userWithPassword: UserWithTemporaryPassword = {
  ...user,
  temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
};

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPatch.mockReset();
});

describe('query keys', () => {
  it('usersQueryKey is scoped per params', () => {
    expect(usersQueryKey({ page: 1 })).toEqual(['users', { page: 1 }]);
  });

  it('userQueryKey is scoped per id', () => {
    expect(userQueryKey(500)).toEqual(['users', 500]);
  });
});

describe('fetchUsers', () => {
  it('requests /users with the given params and returns the parsed list', async () => {
    mockGet.mockResolvedValue({
      data: { data: [user], meta: { page: 1, pageSize: 20, total: 1 } },
    });

    const result = await fetchUsers({ page: 1, sort: 'displayName:asc' });

    expect(mockGet).toHaveBeenCalledWith('/users', {
      params: { page: 1, sort: 'displayName:asc' },
    });
    expect(result.data).toEqual([user]);
    expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
  });

  it('throws an ApiError when the response does not match the shared schema', async () => {
    mockGet.mockResolvedValue({ data: { data: [{ id: 'not-a-number' }] } });
    await expect(fetchUsers({})).rejects.toBeInstanceOf(ApiError);
  });

  it('maps a rejected request into an ApiError (TC-17/TC-18: scope-filtered list, denied elsewhere)', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: { error: { code: 'PERM_DENIED', message: 'No.' } } },
    });
    const error = await fetchUsers({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PERM_DENIED');
  });
});

describe('fetchUser', () => {
  it('requests /users/:id and unwraps {data}', async () => {
    mockGet.mockResolvedValue({ data: { data: user } });
    const result = await fetchUser(500);
    expect(mockGet).toHaveBeenCalledWith('/users/500');
    expect(result).toEqual(user);
  });

  it('maps a 404 (out-of-scope, TC-19) into an ApiError', async () => {
    mockGet.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: { code: 'NOT_FOUND', message: 'Not found.' } } },
    });
    const error = await fetchUser(999).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
  });
});

describe('createUser', () => {
  it('posts to /users and returns the one-time credential (BACKLOG B-01)', async () => {
    mockPost.mockResolvedValue({ data: { data: userWithPassword } });

    const result = await createUser({
      email: 'maker@example.invalid',
      displayName: 'A Maker',
      role: 'maker',
    });

    expect(mockPost).toHaveBeenCalledWith('/users', {
      email: 'maker@example.invalid',
      displayName: 'A Maker',
      role: 'maker',
    });
    expect(result).toEqual(userWithPassword);
  });

  it('maps a role-creation-matrix refusal into an ApiError (TC-2/TC-3/TC-5/TC-6/TC-8/TC-9/TC-10)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 403,
        data: { error: { code: 'ROLE_CREATION_NOT_PERMITTED', message: 'Not permitted.' } },
      },
    });

    const error = await createUser({
      email: 'x@example.invalid',
      displayName: 'X',
      role: 'super_admin',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('ROLE_CREATION_NOT_PERMITTED');
  });

  it('maps a duplicate-email conflict into an ApiError (TC-15)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'USER_EMAIL_EXISTS', message: 'Already exists.' } },
      },
    });

    const error = await createUser({
      email: 'maker@example.invalid',
      displayName: 'A Maker',
      role: 'maker',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('USER_EMAIL_EXISTS');
  });
});

describe('updateUser', () => {
  it('patches /users/:id with only displayName and returns the updated user', async () => {
    mockPatch.mockResolvedValue({ data: { data: { ...user, displayName: 'Renamed' } } });

    const result = await updateUser(500, { displayName: 'Renamed' });

    expect(mockPatch).toHaveBeenCalledWith('/users/500', { displayName: 'Renamed' });
    expect(result.displayName).toBe('Renamed');
  });
});

describe('deactivateUser', () => {
  it('posts to /users/:id/deactivate and returns the updated user (TC-21)', async () => {
    mockPost.mockResolvedValue({ data: { data: { ...user, status: 'inactive' } } });
    const result = await deactivateUser(500);
    expect(mockPost).toHaveBeenCalledWith('/users/500/deactivate', {});
    expect(result.status).toBe('inactive');
  });

  it('maps a self-deactivation refusal into an ApiError (TC-23)', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: { error: { code: 'CANNOT_DEACTIVATE_SELF', message: 'Cannot.' } },
      },
    });
    const error = await deactivateUser(1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('CANNOT_DEACTIVATE_SELF');
  });
});

describe('resetUserPassword', () => {
  it('posts to /users/:id/reset-password and returns the one-time credential (TC-24)', async () => {
    mockPost.mockResolvedValue({ data: { data: userWithPassword } });
    const result = await resetUserPassword(500);
    expect(mockPost).toHaveBeenCalledWith('/users/500/reset-password', {});
    expect(result).toEqual(userWithPassword);
  });
});
