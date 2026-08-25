/**
 * T-024 — `/forgot-password` (04-FRONTEND.md §2, §4; 02-SECURITY.md §2). Replaces T-020's
 * `PublicPlaceholder`.
 *
 * Implementation note 2: *"Forgot-password always shows 'If an account exists for that email,
 * we've sent a reset link.' — same message either way."* The server already guarantees this at
 * the wire level (`AuthController.forgotPassword` answers 204 for every input, in constant
 * time, whether or not the address exists — 02-SECURITY.md §2, T-011 TC-21); this screen adds
 * nothing on top beyond showing the fixed copy on that one, undifferentiated success path. It
 * never makes a second, "does this exist" call first — implementation note 7's "must not
 * pre-check validity in a way that reveals whether \[it] exists" is written about the reset
 * token, but the same reasoning applies here and this screen honours it identically.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../../components/Button';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/Card';
import { Input } from '../../components/Input';
import { ApiError, toApiError } from '../../lib/apiError';
import { describeAuthError } from './api';
import { useForgotPasswordMutation } from './useAuth';

const forgotPasswordFormSchema = z.object({
  email: z.string().min(1, 'Enter your email address').email('Enter a valid email address'),
});

type ForgotPasswordFormValues = z.infer<typeof forgotPasswordFormSchema>;

export function ForgotPasswordPage() {
  const mutation = useForgotPasswordMutation();
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const form = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(forgotPasswordFormSchema),
    defaultValues: { email: '' },
  });

  async function onSubmit(values: ForgotPasswordFormValues): Promise<void> {
    setSubmitError(null);
    try {
      await mutation.mutateAsync(values.email);
      // Deliberately the same regardless of the address — see the file banner. No branch here
      // reads anything into the fact that this call resolved rather than checking who it was.
      setSubmitted(true);
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error : toApiError(error));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="text-lg font-semibold text-slate-900">Forgot your password?</h1>
          <p className="mt-1 text-sm text-slate-500">
            Enter your email and we&apos;ll send you a reset link if we find an account.
          </p>
        </CardHeader>
        {submitted ? (
          <CardBody>
            <p role="status" className="text-sm text-slate-700">
              If an account exists for that email, we&apos;ve sent a reset link.
            </p>
          </CardBody>
        ) : (
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
                label="Email"
                type="email"
                autoComplete="username"
                error={form.formState.errors.email?.message}
                {...form.register('email')}
              />
            </CardBody>
            <CardFooter className="justify-stretch">
              <Button type="submit" className="w-full" isLoading={mutation.isPending}>
                Send reset link
              </Button>
            </CardFooter>
          </form>
        )}
        <div className="border-t border-slate-200 px-6 py-4 text-center text-sm">
          <Link to="/login" className="font-medium text-primary-600 hover:underline">
            Back to log in
          </Link>
        </div>
      </Card>
    </div>
  );
}
