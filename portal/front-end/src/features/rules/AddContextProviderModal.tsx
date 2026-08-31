/**
 * T-162 — `POST /field-context-providers`. Super Admin only, server-enforced
 * (`field-value-source-registries.controller.ts`'s `@RequirePermission(..., 'create')` plus the
 * service's own `assertRole` — see that controller's header); this modal's own trigger button is
 * hidden for every other role in `ValueSourcesPage.tsx` as UX only, never as the real control.
 *
 * Validated with the exact schema the back end validates with
 * (`createFieldContextProviderRequestSchema`, `packages/shared/src/field-value-source.schema.ts`)
 * — the same one-schema-both-sides discipline `AddRuleModal.tsx` follows.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  createFieldContextProviderRequestSchema,
  type CreateFieldContextProviderRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/apiError';
import { useCreateFieldContextProviderMutation } from './api';

interface FormValues {
  providerCode: string;
  name: string;
  description: string;
}

const DEFAULT_VALUES: FormValues = { providerCode: '', name: '', description: '' };

export interface AddContextProviderModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddContextProviderModal({ open, onClose }: AddContextProviderModalProps) {
  const mutation = useCreateFieldContextProviderMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });

  function handleClose(): void {
    setSubmitError(null);
    form.reset(DEFAULT_VALUES);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const payload: CreateFieldContextProviderRequest = {
      providerCode: values.providerCode,
      name: values.name,
      description: values.description === '' ? undefined : values.description,
    };

    const parsed = createFieldContextProviderRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'providerCode' || field === 'name' || field === 'description') {
          form.setError(field, { message: issue.message });
        }
      }
      return;
    }

    try {
      await mutation.mutateAsync(parsed.data);
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
      title="Add context provider"
      description="A 'this journey' value source a rule's parameter field can point at."
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
        <Input
          label="Provider code"
          placeholder="SIBLING_COMPONENTS"
          hint="Upper snake case, e.g. SIBLING_COMPONENTS. Immutable once created."
          error={form.formState.errors.providerCode?.message}
          {...form.register('providerCode')}
        />
        <Input
          label="Name"
          placeholder="Sibling components"
          error={form.formState.errors.name?.message}
          {...form.register('name')}
        />
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="add-context-provider-description"
            className="text-sm font-medium text-slate-700"
          >
            Description
          </label>
          <textarea
            id="add-context-provider-description"
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
            Create provider
          </Button>
        </div>
      </form>
    </Modal>
  );
}
