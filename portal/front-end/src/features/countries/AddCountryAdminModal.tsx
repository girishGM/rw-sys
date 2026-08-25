/**
 * T-030 — `POST /countries/:id/admins`: onboarding a Country Admin for a country that was
 * created without one (03-API-CONTRACT.md §5).
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  createCountryAdminRequestSchema,
  type CountryAdminCreated,
  type CreateCountryAdminRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/apiError';
import { useCreateCountryAdminMutation } from './api';
import { TemporaryPasswordReveal } from './TemporaryPasswordReveal';

export interface AddCountryAdminModalProps {
  open: boolean;
  onClose: () => void;
  countryId: number;
}

export function AddCountryAdminModal({ open, onClose, countryId }: AddCountryAdminModalProps) {
  const mutation = useCreateCountryAdminMutation(countryId);
  const [result, setResult] = useState<CountryAdminCreated | null>(null);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const form = useForm<CreateCountryAdminRequest>({
    resolver: zodResolver(createCountryAdminRequestSchema),
    defaultValues: { email: '', displayName: '' },
  });

  function handleClose(): void {
    setResult(null);
    setSubmitError(null);
    form.reset();
    onClose();
  }

  async function onSubmit(values: CreateCountryAdminRequest): Promise<void> {
    setSubmitError(null);
    try {
      const created = await mutation.mutateAsync(values);
      setResult(created);
    } catch (error) {
      setSubmitError(
        error instanceof ApiError
          ? error
          : new ApiError({
              code: 'UNKNOWN_ERROR',
              message: 'Something went wrong. Please try again.',
              status: 0,
            }),
      );
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Add Country Admin" size="sm">
      {result ? (
        <div className="flex flex-col gap-4">
          <TemporaryPasswordReveal
            email={result.email}
            temporaryPassword={result.temporaryPassword}
          />
          <div className="flex justify-end">
            <Button type="button" onClick={handleClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            void form.handleSubmit(onSubmit)(event);
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          {submitError && (
            <p
              role="alert"
              className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
            >
              {submitError.message}
            </p>
          )}
          <Input
            label="Email"
            type="email"
            error={form.formState.errors.email?.message}
            {...form.register('email')}
          />
          <Input
            label="Display name"
            error={form.formState.errors.displayName?.message}
            {...form.register('displayName')}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" isLoading={mutation.isPending}>
              Create admin
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
