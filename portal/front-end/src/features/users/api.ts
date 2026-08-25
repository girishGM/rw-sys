/**
 * T-035 — the `/users` calls, following the shape `features/tenants/api.ts` (T-034) establishes:
 * `lib/apiClient.ts`'s shared `api` instance, and every response parsed through the matching
 * `packages/shared/src/user.schema.ts` schema — not just cast — so a server/SPA contract drift
 * surfaces as a caught, reported error on this feature rather than as a silent `undefined` deep
 * in a form.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  userEnvelopeSchema,
  userListEnvelopeSchema,
  userWithTemporaryPasswordEnvelopeSchema,
  type CreateUserRequest,
  type UpdateUserRequest,
  type User,
  type UserWithTemporaryPassword,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { toApiError } from '../../lib/apiError';

export interface UserListParams {
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: string;
}

export interface UserListResult {
  readonly data: readonly User[];
  readonly meta: { readonly page: number; readonly pageSize: number; readonly total: number };
}

/** The root key every `/users` query hangs off, so a mutation can invalidate all of it at once. */
export const USERS_ROOT_KEY = ['users'] as const;

export function usersQueryKey(params: UserListParams = {}): readonly [string, UserListParams] {
  return ['users', params] as const;
}

export async function fetchUsers(params: UserListParams): Promise<UserListResult> {
  try {
    const response = await api.get<unknown>('/users', { params });
    const parsed = userListEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Users list response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUsersQuery(
  params: UserListParams = {},
): UseQueryResult<UserListResult, ReturnType<typeof toApiError>> {
  return useQuery({
    queryKey: usersQueryKey(params),
    queryFn: () => fetchUsers(params),
  });
}

export function userQueryKey(id: number): readonly [string, number] {
  return ['users', id] as const;
}

export async function fetchUser(id: number): Promise<User> {
  try {
    const response = await api.get<unknown>(`/users/${String(id)}`);
    const parsed = userEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`User response did not match the expected shape: ${parsed.error.message}`);
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUserQuery(id: number) {
  return useQuery({ queryKey: userQueryKey(id), queryFn: () => fetchUser(id) });
}

export async function createUser(input: CreateUserRequest): Promise<UserWithTemporaryPassword> {
  try {
    const response = await api.post<unknown>('/users', input);
    const parsed = userWithTemporaryPasswordEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Create-user response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useCreateUserMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: USERS_ROOT_KEY });
    },
  });
}

export async function updateUser(id: number, input: UpdateUserRequest): Promise<User> {
  try {
    const response = await api.patch<unknown>(`/users/${String(id)}`, input);
    const parsed = userEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Update-user response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useUpdateUserMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateUserRequest) => updateUser(id, input),
    onSuccess: (user) => {
      queryClient.setQueryData(userQueryKey(id), user);
      void queryClient.invalidateQueries({ queryKey: USERS_ROOT_KEY });
    },
  });
}

export async function deactivateUser(id: number): Promise<User> {
  try {
    const response = await api.post<unknown>(`/users/${String(id)}/deactivate`, {});
    const parsed = userEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Deactivate-user response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useDeactivateUserMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deactivateUser(id),
    onSuccess: (user) => {
      queryClient.setQueryData(userQueryKey(id), user);
      void queryClient.invalidateQueries({ queryKey: USERS_ROOT_KEY });
    },
  });
}

export async function resetUserPassword(id: number): Promise<UserWithTemporaryPassword> {
  try {
    const response = await api.post<unknown>(`/users/${String(id)}/reset-password`, {});
    const parsed = userWithTemporaryPasswordEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(
        `Reset-password response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    return parsed.data.data;
  } catch (error) {
    throw toApiError(error);
  }
}

export function useResetUserPasswordMutation(id: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => resetUserPassword(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: userQueryKey(id) });
    },
  });
}
