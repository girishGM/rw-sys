/**
 * T-024 — `/reset-password?token=…` (04-FRONTEND.md §2, §4). Replaces T-020's
 * `PublicPlaceholder`.
 *
 * Implementation note 7: *"Reset page validates the token by attempting the reset — it must
 * not pre-check validity in a way that reveals whether a token exists."* This screen makes
 * exactly one network call, the submit itself; there is no earlier "is this token valid" probe
 * of any kind, so a token's validity can never be inferred from anything before the user
 * actually acts. An unknown, already-used and expired token are indistinguishable both on the
 * wire (`ResetTokenInvalidHttpException` — one code for all three, see its own comment) and
 * here (`describeAuthError` renders whatever `ApiError.message` the server sent, verbatim,
 * exactly like every other screen in this feature — TC-14/TC-15).
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../components/Button';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/Card';
import { Input } from '../../components/Input';
import { toast } from '../../components/toastActions';
import { ApiError, toApiError } from '../../lib/apiError';
import { AUTH_ERROR_CODE, describeAuthError } from './api';
import { newPasswordSchema, describeViolation } from './passwordPolicy';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';
import { useResetPasswordMutation } from './useAuth';

const resetPasswordFormSchema = z
  .object({
    newPassword: newPasswordSchema,
    confirmPassword: z.string().min(1, 'Confirm your new password'),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

type ResetPasswordFormValues = z.infer<typeof resetPasswordFormSchema>;

function describePolicyViolations(error: ApiError): string {
  const codes = error.details?.map((detail) => detail.code) ?? [];
  return codes.length > 0 ? codes.map(describeViolation).join(' ') : error.message;
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // An absent token is not special-cased (implementation note 7) — it is simply a token the
  // reset call will reject exactly like an expired or already-used one, via the same generic
  // `AUTH_RESET_TOKEN_INVALID` response `submitError` below already renders.
  const token = params.get('token') ?? '';
  const mutation = useResetPasswordMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const form = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordFormSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  const newPasswordValue = form.watch('newPassword');

  async function onSubmit(values: ResetPasswordFormValues): Promise<void> {
    setSubmitError(null);
    try {
      await mutation.mutateAsync({ token, newPassword: values.newPassword });
      toast.success('Password reset. Please log in.');
      navigate('/login', { replace: true });
    } catch (error) {
      const apiError = error instanceof ApiError ? error : toApiError(error);

      if (apiError.code === AUTH_ERROR_CODE.PASSWORD_POLICY) {
        form.setError('newPassword', {
          type: 'server',
          message: describePolicyViolations(apiError),
        });
        return;
      }

      // Covers `AUTH_RESET_TOKEN_INVALID` (TC-14/TC-15) and everything else generically —
      // rendered verbatim, exactly as every other screen in this feature does.
      setSubmitError(apiError);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 className="text-lg font-semibold text-slate-900">Reset your password</h1>
          <p className="mt-1 text-sm text-slate-500">Choose a new password for your account.</p>
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
            <Button type="submit" className="w-full" isLoading={mutation.isPending}>
              Reset password
            </Button>
          </CardFooter>
        </form>
        <div className="border-t border-slate-200 px-6 py-4 text-center text-sm">
          <Link to="/login" className="font-medium text-primary-600 hover:underline">
            Back to log in
          </Link>
        </div>
      </Card>
    </div>
  );
}
