/**
 * T-020 — the bootstrap query, its React context, and the `useBootstrap()` / `useLogout()`
 * hooks every guard and (eventually) every screen reads from (04-FRONTEND.md §2, §3, §9).
 *
 * Deliberately a non-component file: `BootstrapProvider.tsx` next to this one only exports
 * the `<BootstrapProvider>` component itself, so `eslint-plugin-react-refresh`'s
 * `only-export-components` rule (which the workspace lint gate runs at
 * `--max-warnings=0`) has nothing to flag there. Everything that is *not* a component —
 * the context object, the query hook, the logout hook, the shared types — lives here
 * instead.
 *
 * `GET /me/bootstrap` is itself the only signal the SPA has for "is there a valid session?"
 * (04-FRONTEND.md §2: "Direct navigation to any URL without a session redirects to
 * `/login`, and the underlying API call returns 401 regardless"). There is no separate,
 * lighter-weight session check to make first — the cookie is HttpOnly, so client code
 * cannot inspect it, and a 401 on this call *is* "no session".
 */
import { createContext, useCallback, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import type { Bootstrap } from '@reward-portal/shared';
import { readCsrfCookie } from './readCsrfCookie';

export const BOOTSTRAP_QUERY_KEY = ['bootstrap'] as const;

/**
 * A bare axios instance scoped to this one call.
 *
 * T-022 (API client) owns the shared `lib/apiClient.ts` with its single-flight refresh
 * queue, CSRF injection and typed error mapping — none of which this call needs: it is a
 * `GET`, so no CSRF header is required (04-FRONTEND.md §8 only injects `X-CSRF-Token` on
 * non-GET/HEAD/OPTIONS), and a 401 here is meaningful on its own (RequireAuth reacts to it
 * directly) rather than something to transparently retry behind a refresh. Introducing the
 * full client's retry machinery here would risk masking the very 401 RequireAuth needs to
 * see.
 */
const bootstrapHttp = axios.create({ baseURL: '/api/v1', withCredentials: true });

async function fetchBootstrap(): Promise<Bootstrap> {
  const response = await bootstrapHttp.get<{ data: Bootstrap }>('/me/bootstrap');
  return response.data.data;
}

/** True for a 401 response specifically — the one error RequireAuth treats as "log in again". */
export function isUnauthorizedError(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 401;
}

/**
 * T-024 — true for the one 403 `/me/bootstrap` can return: `PASSWORD_CHANGE_REQUIRED`
 * (`PasswordChangeRequiredGuard`, 02-SECURITY.md §2 — "restricts the session to exactly two
 * endpoints", and `/me/bootstrap` is not one of them, by `me.controller.ts`'s own deliberate
 * choice not to exempt it). `RequireBootstrap` treats this the way `RequireAuth` treats a 401:
 * a definitive, known reason to redirect rather than show a generic retry page — see that
 * component's own comment for why a plain `isError` branch is the wrong answer for this one
 * specific cause.
 */
export function isPasswordChangeRequiredError(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 403) return false;
  const body = error.response?.data as { error?: { code?: unknown } } | undefined;
  return body?.error?.code === 'PASSWORD_CHANGE_REQUIRED';
}

export interface BootstrapContextValue {
  readonly user: Bootstrap['user'] | undefined;
  readonly scope: Bootstrap['scope'] | undefined;
  readonly nav: Bootstrap['nav'];
  readonly permissions: Bootstrap['permissions'];
  readonly widgets: Bootstrap['widgets'];
  readonly messages: Bootstrap['messages'];
  /** No data has arrived yet (first load only — a background refetch does not set this). */
  readonly isLoading: boolean;
  /** The most recent attempt failed, for any reason. */
  readonly isError: boolean;
  /** The most recent attempt failed with a 401 — "this session is no longer valid". */
  readonly isUnauthorized: boolean;
  /**
   * T-024 — the most recent attempt failed with 403 `PASSWORD_CHANGE_REQUIRED`: the session is
   * valid but confined to `/change-password` and `/auth/logout` (02-SECURITY.md §2).
   *
   * Optional, not `readonly isPasswordChangeRequired: boolean` like its siblings above,
   * deliberately: several other tasks' fixtures (`features/trace/**`, out of T-024's file
   * scope per AGENT-PROTOCOL R9) construct a `BootstrapContextValue` literal by hand and
   * predate this field. Making it optional keeps every one of those literals valid — a
   * consumer that omits it simply reads `undefined`, which every check in this codebase
   * treats as falsy — rather than forcing an edit to files this task does not own.
   */
  readonly isPasswordChangeRequired?: boolean;
  readonly hasPermission: (entity: string, action: string) => boolean;
  readonly refetch: () => void;
}

export const BootstrapContext = createContext<BootstrapContextValue | null>(null);

/**
 * Reads the bootstrap payload from the nearest `<BootstrapProvider>`.
 *
 * Mirrors the usage shown in 04-FRONTEND.md §3 exactly: `const { nav } = useBootstrap()`,
 * `const { widgets } = useBootstrap()`. `nav`/`permissions`/`widgets`/`messages` are always
 * arrays/objects (never `undefined`) so a consumer never needs an extra guard — by the time
 * `RequireBootstrap` lets children render at all, the data is guaranteed to have arrived.
 */
export function useBootstrap(): BootstrapContextValue {
  const ctx = useContext(BootstrapContext);
  if (!ctx) {
    throw new Error('useBootstrap() must be called within a <BootstrapProvider>.');
  }
  return ctx;
}

/**
 * The query itself — used only by `BootstrapProvider`, which turns it into the context
 * above. Exported so `BootstrapProvider.tsx` (a component-only file, see the file banner)
 * does not need to duplicate the query definition.
 */
export function useBootstrapQuery() {
  return useQuery({
    queryKey: BOOTSTRAP_QUERY_KEY,
    queryFn: fetchBootstrap,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    // A 401 is definitive — retrying it only delays the redirect RequireAuth needs to make.
    // Anything else gets a couple of attempts before RequireBootstrap shows the error page,
    // so one transient network blip does not read as a hard failure.
    retry: (failureCount, error) => !isUnauthorizedError(error) && failureCount < 2,
  });
}

/**
 * `POST /auth/logout`, then unconditionally clears every cached query and sends the user to
 * `/login` (04-FRONTEND.md §2 implementation note 6, §9: "On logout, `queryClient.clear()`
 * is mandatory... leaving another user's cached data in memory across a login on a shared
 * machine is a real leak").
 *
 * The network call is best-effort: even if it fails (offline, session already gone
 * server-side, ...) the client-side state is dropped and the redirect happens anyway —
 * never leave the previous user's data reachable just because the logout request itself
 * failed.
 *
 * T-064 — a **push**, not `{ replace: true }`. `replace` discards the pre-logout entry instead
 * of adding a new one on top of it; when the page the user was on happened to be the *first*
 * entry the SPA itself ever pushed (a direct visit, a fresh tab, a bookmark), replacing it away
 * leaves nothing of the app's own history behind it for the browser's Back button to land on —
 * only whatever pre-app document the tab started from (`about:blank` in the reproduction this
 * fixes). A push always leaves that original route in place, so Back has a real, still-guarded
 * route to land on. That route is guaranteed not to show anything authenticated: the
 * `queryClient.clear()` above already ran, so the guard chain (`RequireAuth`/`RequireBootstrap`)
 * re-mounts with no cached bootstrap data and re-checks the session from scratch — a skeleton,
 * then a redirect to `/login`, never a flash of the page that was there before (see
 * `RequireBootstrap`'s own comment on why `isLoading` — no stale data, no observer to serve it
 * from — is the guaranteed first render in that situation).
 */
export function useLogout(): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useCallback(async () => {
    try {
      await bootstrapHttp.post('/auth/logout', null, {
        headers: { 'X-CSRF-Token': readCsrfCookie() ?? '' },
      });
    } catch {
      // Best-effort — see the function banner. Falls through to the cleanup below either way.
    } finally {
      queryClient.clear();
      navigate('/login');
    }
  }, [queryClient, navigate]);
}
