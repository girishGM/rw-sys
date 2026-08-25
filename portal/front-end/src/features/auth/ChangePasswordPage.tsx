/**
 * T-024 — `/change-password` (04-FRONTEND.md §2, §4). Replaces T-020's generic `RouteStub` for
 * this path.
 *
 * ### Why this is a standalone top-level route, not one of `PROTECTED_ROUTE_SPECS`
 *
 * 04-FRONTEND.md §2's route table lists `/change-password` *above* the
 * "`<RequireAuth> → <RequireBootstrap> → <RequireNav path>`" line every other authenticated
 * screen sits below — a real, load-bearing distinction, not a formatting accident. A confined
 * session (`must_change_password = true`) gets a 403 `PASSWORD_CHANGE_REQUIRED` from
 * `/me/bootstrap` itself (`me.controller.ts` deliberately does not exempt it — see
 * `PasswordChangeRequiredGuard`'s own doc comment). Routing this screen through the ordinary
 * `ProtectedLayout` (`BootstrapProvider` → `RequireAuth` → `RequireBootstrap` → `AppShell`)
 * would mean the one screen a confined session *must* be able to reach is exactly the one
 * `RequireBootstrap` would refuse to render past its own error page — a screen that can never
 * be its own escape hatch is not an escape hatch. `router.tsx` mounts this component directly
 * instead, with its own lightweight, authentication-only check below, and — just as
 * importantly — with no `AppShell` around it: implementation note 4's "no nav, no escape" is
 * satisfied structurally (there is no sidebar here to navigate away with) rather than by hiding
 * nav items after the fact.
 *
 * This screen also serves the *voluntary*, non-confined self-service case (04-FRONTEND.md §4's
 * screen inventory: "Change password | all"). The same standalone rendering applies there too —
 * deliberately no "cancel" link back into the app, so the one form this task owns behaves
 * identically regardless of why the caller arrived. Noted as a minor scope choice in the T-024
 * completion report.
 */
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../components/Button';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/Card';
import { Input } from '../../components/Input';
import { toast } from '../../components/toastActions';
import { ApiError, toApiError } from '../../lib/apiError';
import {
  isPasswordChangeRequiredError,
  isUnauthorizedError,
  useBootstrapQuery,
} from '../../auth/useBootstrap';
import { buildLoginRedirect } from '../../auth/nextPath';
import { AUTH_ERROR_CODE, describeAuthError } from './api';
import { newPasswordSchema, describeViolation } from './passwordPolicy';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';
import { useChangePasswordMutation } from './useAuth';

const changePasswordFormSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: newPasswordSchema,
    confirmPassword: z.string().min(1, 'Confirm your new password'),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

type ChangePasswordFormValues = z.infer<typeof changePasswordFormSchema>;

/** Reads the details array a 400 `AUTH_PASSWORD_POLICY` carries into one rendered string. */
function describePolicyViolations(error: ApiError): string {
  const codes = error.details?.map((detail) => detail.code) ?? [];
  return codes.length > 0 ? codes.map(describeViolation).join(' ') : error.message;
}

export function ChangePasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const bootstrapQuery = useBootstrapQuery();
  const changePasswordMutation = useChangePasswordMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const form = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordFormSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const newPasswordValue = form.watch('newPassword');

  // A definitive 401 means there is no session at all — same signal `RequireAuth` reacts to.
  // While the query is still in flight this renders the form anyway (mirrors `RequireAuth`'s
  // own "render children unconditionally while loading" — see that component's comment); the
  // worst case is a one-frame flash for a caller with no session who typed this URL directly,
  // which is the same UX-only trade-off every guard in this chain already makes.
  if (!bootstrapQuery.isPending && isUnauthorizedError(bootstrapQuery.error)) {
    return <Navigate to={buildLoginRedirect(location.pathname, location.search)} replace />;
  }

  const isConfined = isPasswordChangeRequiredError(bootstrapQuery.error);

  async function onSubmit(values: ChangePasswordFormValues): Promise<void> {
    setSubmitError(null);
    try {
      await changePasswordMutation.mutateAsync(values);
      toast.success('Password changed.');
      navigate('/dashboard', { replace: true });
    } catch (error) {
      const apiError = error instanceof ApiError ? error : toApiError(error);

      if (apiError.code === AUTH_ERROR_CODE.PASSWORD_POLICY) {
        form.setError('newPassword', {
          type: 'server',
          message: describePolicyViolations(apiError),
        });
        return;
      }

      if (apiError.code === AUTH_ERROR_CODE.INVALID_CREDENTIALS) {
        // Same generic, undifferentiated message the login screen renders — the server does
        // not tell this endpoint apart from a login failure either (implementation note 1's
        // reasoning applies here too, one authenticated layer up).
        form.resetField('currentPassword');
        form.setError('currentPassword', { type: 'server', message: apiError.message });
        return;
      }

      setSubmitError(apiError);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 className="text-lg font-semibold text-slate-900">Change your password</h1>
          {isConfined && (
            <p className="mt-2 text-sm text-slate-600">
              Your account requires a new password before you can continue.
            </p>
          )}
        </CardHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
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
              label="Current password"
              type="password"
              autoComplete="current-password"
              error={form.formState.errors.currentPassword?.message}
              {...form.register('currentPassword')}
            />
            <div className="flex flex-col gap-2">
              <Input
                label="New password"
                type="password"
                autoComplete="new-password"
                error={form.formState.errors.newPassword?.message}
                {...form.register('newPassword')}
              />
              <PasswordStrengthMeter password={newPasswordValue ?? ''} />
            </div>
            <Input
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              error={form.formState.errors.confirmPassword?.message}
              {...form.register('confirmPassword')}
            />
          </CardBody>
          <CardFooter className="justify-stretch">
            <Button type="submit" className="w-full" isLoading={changePasswordMutation.isPending}>
              Change password
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
