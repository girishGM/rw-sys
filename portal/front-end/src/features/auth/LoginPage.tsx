/**
 * T-024 — `/login` (04-FRONTEND.md §2, §4; 02-SECURITY.md §2). Replaces T-020's
 * `LoginPlaceholder` outright.
 *
 * ### The anti-enumeration contract (implementation note 1)
 *
 * Every login failure — unknown email, wrong password, locked, inactive — is one `ApiError`
 * with one `code` (`AUTH_INVALID_CREDENTIALS`) and one `message`, because the server refuses to
 * carry a discriminator (`InvalidCredentialsHttpException`'s own comment: "constructed with no
 * arguments on purpose"). This screen therefore has **nothing to branch on** for those four
 * causes — it renders `error.message` verbatim (`describeAuthError`, `./api.ts`) and nothing
 * else, which is what makes TC-2/TC-3/TC-4 pixel-identical by construction rather than by
 * discipline.
 *
 * ### `mfaRequired` — closed by T-060
 *
 * T-055 (Wave 1) made MFA mandatory for `super_admin`: `POST /auth/login` for that role answers
 * `{ mfaRequired: true }` with **no session created at all** (02-SECURITY.md §2a). T-024's own
 * task file scoped MFA out ("Out: MFA (post-v1)"), and for a while no task built the screen that
 * branch needed — so, as originally shipped, a `super_admin` could not complete a login through
 * this SPA at all. T-060 (`MfaChallengePage.tsx`, `mfaApi.ts`) closes that gap: this branch does
 * **not** treat `mfaRequired: true` as success (no session exists yet to navigate on the
 * strength of), and instead hands off to `/mfa-challenge`, preserving `next` exactly as the
 * ordinary post-login redirect below does, so the eventual destination is unaffected by whether
 * a second factor was needed along the way.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../components/Button';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/Card';
import { Input } from '../../components/Input';
import { ApiError, toApiError } from '../../lib/apiError';
import { resolveNextPath } from '../../auth/nextPath';
import { describeAuthError } from './api';
import { useLoginMutation } from './useAuth';

const loginFormSchema = z.object({
  email: z.string().min(1, 'Enter your email address').email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

type LoginFormValues = z.infer<typeof loginFormSchema>;

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get('next');
  const loginMutation = useLoginMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: LoginFormValues): Promise<void> {
    setSubmitError(null);
    try {
      const result = await loginMutation.mutateAsync(values);

      if (result.mfaRequired) {
        // See the file banner (T-060) — no session exists on this branch, so there is nothing
        // to invalidate or navigate towards in the ordinary sense; the pending challenge takes
        // over from here. Password value is dropped either way (implementation note 5).
        form.resetField('password');
        const target = next ? `/mfa-challenge?next=${encodeURIComponent(next)}` : '/mfa-challenge';
        navigate(target, { replace: true });
        return;
      }

      if (result.mustChangePassword) {
        // Forced confinement takes priority over `next` (implementation note 4) — the user is
        // going to `/change-password` regardless of where they were originally headed.
        navigate('/change-password', { replace: true });
        return;
      }

      navigate(resolveNextPath(next), { replace: true });
    } catch (error) {
      const apiError = error instanceof ApiError ? error : toApiError(error);
      // TC-2: "field values preserved except the password" — only the password is cleared.
      form.resetField('password');
      form.setFocus('password');
      setSubmitError(apiError);
    }
  }

  const showSessionExpired = Boolean(next) && !submitError;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-lg font-semibold text-slate-900">Log in</h1>
          <p className="mt-1 text-sm text-slate-500">Sign in to the Reward Portal.</p>
        </CardHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <CardBody className="flex flex-col gap-4">
            {showSessionExpired && (
              <p
                role="status"
                className="rounded-control bg-primary-50 px-3 py-2 text-sm text-primary-700"
              >
                Your session has expired, please sign in again.
              </p>
            )}
            {submitError && (
              <p
                role="alert"
                className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
              >
                {describeAuthError(submitError)}
              </p>
            )}
            <Input
              label="Email"
              type="email"
              autoComplete="username"
              error={form.formState.errors.email?.message}
              {...form.register('email')}
            />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              error={form.formState.errors.password?.message}
              {...form.register('password')}
            />
          </CardBody>
          <CardFooter className="justify-stretch">
            <Button type="submit" className="w-full" isLoading={loginMutation.isPending}>
              Log in
            </Button>
          </CardFooter>
        </form>
        <div className="border-t border-slate-200 px-6 py-4 text-center text-sm">
          <Link to="/forgot-password" className="font-medium text-primary-600 hover:underline">
            Forgot your password?
          </Link>
        </div>
      </Card>
    </div>
  );
}
