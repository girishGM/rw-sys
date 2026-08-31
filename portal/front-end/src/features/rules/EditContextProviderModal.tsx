/**
 * T-162 — `PATCH /field-context-providers/:id`. `providerCode` is immutable and never shown as
 * an editable field here (matches `UpdateFieldContextProviderDto`'s own shape — the back end
 * does not accept it either).
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  updateFieldContextProviderRequestSchema,
  type FieldContextProvider,
  type UpdateFieldContextProviderRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select, type SelectOption } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { useUpdateFieldContextProviderMutation } from './api';

const STATUS_OPTIONS: SelectOption[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

interface FormValues {
  name: string;
  description: string;
  status: string;
}

export interface EditContextProviderModalProps {
  open: boolean;
  onClose: () => void;
  provider: FieldContextProvider;
}

export function EditContextProviderModal({
  open,
  onClose,
  provider,
}: EditContextProviderModalProps) {
  const mutation = useUpdateFieldContextProviderMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const form = useForm<FormValues>({
    defaultValues: {
      name: provider.name,
      description: provider.description ?? '',
      status: provider.status,
    },
  });

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    form.reset({
      name: provider.name,
      description: provider.description ?? '',
      status: provider.status,
    });
    // Only re-sync when the modal (re)opens for a given provider, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [open, provider.id]);

  function handleClose(): void {
    setSubmitError(null);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const payload: UpdateFieldContextProviderRequest = {
      name: values.name,
      description: values.description,
      status:
        values.status === 'active' || values.status === 'inactive' ? values.status : undefined,
    };

    const parsed = updateFieldContextProviderRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'name' || field === 'description') {
          form.setError(field, { message: issue.message });
        }
      }
      return;
    }

    try {
      await mutation.mutateAsync({ id: provider.id, input: parsed.data });
      handleClose();
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
    <Modal
      open={open}
      onClose={handleClose}
      title={`Edit ${provider.providerCode}`}
      description="Provider code is immutable."
    >
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
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Name"
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
          <Select
            label="Status"
            options={STATUS_OPTIONS}
            value={form.watch('status')}
            onChange={(value) => form.setValue('status', value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="edit-context-provider-description"
            className="text-sm font-medium text-slate-700"
          >
            Description
          </label>
          <textarea
            id="edit-context-provider-description"
            rows={2}
            className="rounded-control border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            {...form.register('description')}
          />
          {form.formState.errors.description?.message && (
            <p role="alert" className="text-xs text-danger-600">
              {form.formState.errors.description.message}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={mutation.isPending}>
            Save changes
          </Button>
        </div>
      </form>
    </Modal>
  );
}
