/**
 * T-060 — `/mfa-challenge` (02-SECURITY.md §2a). Closes the gap `LoginPage.tsx`'s own comment
 * used to document: T-055 (Wave 1) made a second factor mandatory for `super_admin` and built
 * the three `/auth/mfa/*` routes, but no screen ever consumed them, so a Super Admin could not
 * complete a login through a browser at all. `LoginPage.tsx`'s `mfaRequired` branch now
 * navigates here instead of showing a dead-end notice.
 *
 * ### One call decides which of two screens this renders (TC-1, TC-4)
 *
 * There is no `GET /auth/mfa/status`. What this screen does instead, on mount, is call
 * `POST /auth/mfa/enrol` (`mfaApi.ts#enrolMfa`) and read what comes back:
 *
 *  - **200** → the account has no confirmed factor yet. The response *is* the enrolment offer
 *    (secret + `otpauthUri`), so the same call that asked the question also answered it —
 *    nothing here can render a fresh offer without it being genuine.
 *  - **403 `MFA_ALREADY_ENROLLED`** → the account is already enrolled; skip straight to the
 *    6-digit challenge, exactly as TC-4 requires.
 *  - **401 `AUTH_SESSION_INVALID`** → there is no valid pending token (absent, expired, forged —
 *    `mfa.controller.ts`'s `pendingTokenFrom` found nothing to verify). The only correct
 *    reaction is `/login` (TC-12), and the same branch covers TC-13's "browser refresh mid
 *    challenge": the five-minute pending token may simply have expired while the tab sat idle.
 *
 * `enrolMfa` is not rate-limited (`throttler.config.ts` — "`/auth/mfa/enrol` is deliberately
 * absent"), so calling it once per mount, including on every browser refresh, costs nothing a
 * real attacker could exploit.
 *
 * ### No QR code (deviation, mirrors T-055's own)
 *
 * `MfaEnrolmentResponseDto`'s own comment: *"no QR encoder is available to this workspace...
 * recorded as a deviation."* This screen renders the same deviation on the other side: the
 * secret and the `otpauthUri` are both shown as **plain, selectable text** — sufficient for a
 * human to type into an authenticator app by hand, and the only representation an agent-run
 * browser test can read at all (a QR code cannot be photographed by a test runner). Adding an
 * npm dependency to encode one is outside this task's file scope (`front-end/package.json` is
 * not in T-060's "Files owned" list) and is flagged here rather than done silently.
 *
 * ### Recovery codes and the secret are both "shown once" (TC-1, TC-2)
 *
 * Neither is held in any component state that survives past the screen that displays it, neither
 * is written to any browser storage a script can read back later (R5 — `mfaApi.ts`'s own header
 * explains why this comment deliberately does not spell out either storage API's name), and
 * neither can be re-fetched: the secret only ever appears in the one `enrolMfa` response that
 * preceded a confirmed enrolment, and the ten recovery codes only ever appear in the one
 * `verifyMfa` response that completed one (`recoveryCodes` is `undefined` on every other
 * response — see `mfaApi.ts`).
 *
 * ### The pending cookie needs nothing from this screen (R5)
 *
 * `__Host-rs_mfa` is `HttpOnly`; it travels with every request under `Path=/` on its own. This
 * file never reads it, names it in a request body, or stores anything in its place — see
 * `mfaApi.ts`'s own header.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Button } from '../../components/Button';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/Card';
import { Input } from '../../components/Input';
import { Skeleton } from '../../components/Skeleton';
import { ApiError, toApiError } from '../../lib/apiError';
import { resolveNextPath } from '../../auth/nextPath';
import { BOOTSTRAP_QUERY_KEY } from '../../auth/useBootstrap';
import { describeAuthError } from './api';
import {
  MFA_ERROR_CODE,
  enrolMfa,
  recoverMfa,
  verifyMfa,
  type MfaChallengeResult,
  type MfaEnrolmentOffer,
} from './mfaApi';

const codeFormSchema = z.object({
  code: z.string().min(1, 'Enter the 6-digit code from your authenticator app'),
});
type CodeFormValues = z.infer<typeof codeFormSchema>;

const recoveryFormSchema = z.object({
  code: z.string().min(1, 'Enter one of your recovery codes'),
});
type RecoveryFormValues = z.infer<typeof recoveryFormSchema>;

type Phase =
  | { readonly name: 'loading' }
  | { readonly name: 'load-error'; readonly message: string }
  | { readonly name: 'enrol'; readonly offer: MfaEnrolmentOffer }
  | { readonly name: 'challenge' }
  | { readonly name: 'recovery' }
  | { readonly name: 'recovery-codes'; readonly codes: readonly string[] };

/** Splits a TOTP secret / recovery code into 4-character groups, purely for readability — the
 * server accepts (and TC-1/TC-11's own display already prints) grouped and ungrouped forms
 * identically. Cosmetic only; never sent anywhere in this grouped form. */
function grouped(value: string): string {
  return (value.match(/.{1,4}/g) ?? [value]).join(' ');
}

export function MfaChallengePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const next = params.get('next');

  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [pendingMustChangePassword, setPendingMustChangePassword] = useState(false);

  /** Guards the initial `enrolMfa` call against React 18 StrictMode's deliberate double-effect
   * (mirrors `useAgentSession.ts`'s `bootstrapped` ref — T-049, the same pattern). */
  const bootstrapped = useRef(false);
  /** Set on unmount so a late-resolving call cannot `setState` on a dead component. */
  const alive = useRef(true);

  const codeForm = useForm<CodeFormValues>({
    resolver: zodResolver(codeFormSchema),
    defaultValues: { code: '' },
  });
  const recoveryForm = useForm<RecoveryFormValues>({
    resolver: zodResolver(recoveryFormSchema),
    defaultValues: { code: '' },
  });

  const loadChallenge = useCallback(async () => {
    setPhase({ name: 'loading' });
    setSubmitError(null);
    try {
      const offer = await enrolMfa();
      if (alive.current) setPhase({ name: 'enrol', offer });
    } catch (error) {
      const apiError = error instanceof ApiError ? error : toApiError(error);
      if (!alive.current) return;

      // TC-12/TC-13 — no valid pending token (missing, expired, or this is a direct visit with
      // no login attempt behind it at all). Starting over at `/login` is the only correct move;
      // see this file's own header.
      if (apiError.status === 401) {
        navigate('/login', { replace: true });
        return;
      }

      // TC-4 — an already-enrolled account skips straight to the challenge.
      if (apiError.status === 403 && apiError.code === MFA_ERROR_CODE.ALREADY_ENROLLED) {
        setPhase({ name: 'challenge' });
        return;
      }

      setPhase({ name: 'load-error', message: describeAuthError(apiError) });
    }
  }, [navigate]);

  useEffect(() => {
    alive.current = true;
    if (!bootstrapped.current) {
      bootstrapped.current = true;
      void loadChallenge();
    }
    return () => {
      alive.current = false;
    };
  }, [loadChallenge]);

  /** The shared landing logic every successful path (verify, recover, and "codes saved") ends
   * with — one place that decides `/change-password` vs. wherever the caller was headed, the
   * same ordering `LoginPage.tsx` already uses for a password-only login (TC-6, TC-7). */
  function finish(mustChangePassword: boolean): void {
    // A fresh session now exists where none did before this screen was reached — the next
    // mount must fetch it, not a cached 401/403 left over from before the challenge was
    // satisfied (mirrors `useLoginMutation`'s own `onSuccess`).
    void queryClient.invalidateQueries({ queryKey: BOOTSTRAP_QUERY_KEY });
    if (mustChangePassword) {
      navigate('/change-password', { replace: true });
      return;
    }
    navigate(resolveNextPath(next), { replace: true });
  }

  function handleResult(result: MfaChallengeResult): void {
    if (result.recoveryCodes && result.recoveryCodes.length > 0) {
      // TC-1 — shown exactly once, before landing anywhere else.
      setPendingMustChangePassword(result.mustChangePassword);
      setPhase({ name: 'recovery-codes', codes: result.recoveryCodes });
      return;
    }
    finish(result.mustChangePassword);
  }

  /** Maps a failed `verifyMfa`/`recoverMfa` call: a dead pending token restarts at `/login`
   * (TC-13); everything else — wrong code, reused/unknown recovery code, 429 — is rendered
   * inline and the caller stays right here (TC-5, TC-9). */
  function handleFailure(error: unknown): void {
    const apiError = error instanceof ApiError ? error : toApiError(error);
    if (apiError.status === 401 && apiError.code === MFA_ERROR_CODE.SESSION_INVALID) {
      navigate('/login', { replace: true });
      return;
    }
    setSubmitError(apiError);
  }

  async function onSubmitCode(values: CodeFormValues): Promise<void> {
    setSubmitError(null);
    try {
      const result = await verifyMfa(values.code);
      codeForm.resetField('code');
      handleResult(result);
    } catch (error) {
      codeForm.resetField('code');
      codeForm.setFocus('code');
      handleFailure(error);
    }
  }

  async function onSubmitRecovery(values: RecoveryFormValues): Promise<void> {
    setSubmitError(null);
    try {
      const result = await recoverMfa(values.code);
      recoveryForm.resetField('code');
      handleResult(result);
    } catch (error) {
      recoveryForm.resetField('code');
      recoveryForm.setFocus('code');
      handleFailure(error);
    }
  }

  if (phase.name === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-sm">
          <CardBody
            className="flex flex-col gap-3"
            role="status"
            aria-label="Checking your account"
          >
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardBody>
        </Card>
      </div>
    );
  }

  if (phase.name === 'load-error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
          </CardHeader>
          <CardBody>
            <p role="alert" className="text-sm text-danger-700">
              {phase.message}
            </p>
          </CardBody>
          <CardFooter className="justify-stretch">
            <Button className="w-full" onClick={() => void loadChallenge()}>
              Retry
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (phase.name === 'recovery-codes') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <h1 className="text-lg font-semibold text-slate-900">Save your recovery codes</h1>
            <p className="mt-1 text-sm text-slate-500">
              Store these somewhere safe. Each code works once, if you ever lose access to your
              authenticator app. They will not be shown again.
            </p>
          </CardHeader>
          <CardBody>
            <ul className="grid grid-cols-2 gap-2 rounded-control bg-slate-50 p-4 font-mono text-sm">
              {phase.codes.map((code) => (
                <li key={code}>
                  <code className="select-all">{code}</code>
                </li>
              ))}
            </ul>
          </CardBody>
          <CardFooter className="justify-stretch">
            <Button className="w-full" onClick={() => finish(pendingMustChangePassword)}>
              I&apos;ve saved these codes — continue
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (phase.name === 'enrol') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <h1 className="text-lg font-semibold text-slate-900">
              Set up two-factor authentication
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Your account requires an authenticator app. Add this account using the key below, then
              enter the 6-digit code it shows.
            </p>
          </CardHeader>
          <form onSubmit={codeForm.handleSubmit(onSubmitCode)} noValidate>
            <CardBody className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-slate-700">Setup key</span>
                <code className="select-all break-all rounded-control bg-slate-50 px-3 py-2 text-sm text-slate-900">
                  {grouped(phase.offer.secret)}
                </code>
                <p className="text-xs text-slate-500">
                  Account: {phase.offer.account} · Issuer: {phase.offer.issuer}
                </p>
              </div>
              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer select-none">
                  Can&apos;t scan a code? Use this link instead
                </summary>
                <code className="mt-2 block select-all break-all rounded-control bg-slate-50 px-3 py-2">
                  {phase.offer.otpauthUri}
                </code>
              </details>
              {submitError && (
                <p
                  role="alert"
                  className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
                >
                  {describeAuthError(submitError)}
                </p>
              )}
              <Input
                label="Verification code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                error={codeForm.formState.errors.code?.message}
                {...codeForm.register('code')}
              />
            </CardBody>
            <CardFooter className="justify-stretch">
              <Button type="submit" className="w-full" isLoading={codeForm.formState.isSubmitting}>
                Enable two-factor authentication
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    );
  }

  if (phase.name === 'recovery') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <h1 className="text-lg font-semibold text-slate-900">Use a recovery code</h1>
            <p className="mt-1 text-sm text-slate-500">
              Enter one of the recovery codes you saved when you set up two-factor authentication.
              Each code only works once.
            </p>
          </CardHeader>
          <form onSubmit={recoveryForm.handleSubmit(onSubmitRecovery)} noValidate>
            <CardBody className="flex flex-col gap-4">
              {submitError && (
                <p
                  role="alert"
                  className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
                >
                  {describeAuthError(submitError)}
                </p>
              )}
              <Input
                label="Recovery code"
                autoComplete="off"
                error={recoveryForm.formState.errors.code?.message}
                {...recoveryForm.register('code')}
              />
            </CardBody>
            <CardFooter className="justify-stretch">
              <Button
                type="submit"
                className="w-full"
                isLoading={recoveryForm.formState.isSubmitting}
              >
                Use recovery code
              </Button>
            </CardFooter>
          </form>
          <div className="border-t border-slate-200 px-6 py-4 text-center text-sm">
            <button
              type="button"
              onClick={() => {
                setSubmitError(null);
                setPhase({ name: 'challenge' });
              }}
              className="font-medium text-primary-600 hover:underline"
            >
              Back to your authenticator code
            </button>
          </div>
        </Card>
      </div>
    );
  }

  // phase.name === 'challenge'
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-lg font-semibold text-slate-900">Enter your verification code</h1>
          <p className="mt-1 text-sm text-slate-500">
            Enter the 6-digit code from your authenticator app.
          </p>
        </CardHeader>
        <form onSubmit={codeForm.handleSubmit(onSubmitCode)} noValidate>
          <CardBody className="flex flex-col gap-4">
            {submitError && (
              <p
                role="alert"
                className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
              >
                {describeAuthError(submitError)}
              </p>
            )}
            <Input
              label="Verification code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              error={codeForm.formState.errors.code?.message}
              {...codeForm.register('code')}
            />
          </CardBody>
          <CardFooter className="justify-stretch">
            <Button type="submit" className="w-full" isLoading={codeForm.formState.isSubmitting}>
              Verify
            </Button>
          </CardFooter>
        </form>
        <div className="border-t border-slate-200 px-6 py-4 text-center text-sm">
          <button
            type="button"
            onClick={() => {
              setSubmitError(null);
              setPhase({ name: 'recovery' });
            }}
            className="font-medium text-primary-600 hover:underline"
          >
            Lost your device? Use a recovery code
          </button>
        </div>
      </Card>
    </div>
  );
}
