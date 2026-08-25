/**
 * T-042 — `PATCH /definition-requests/:id`. Requester only, and only while `status: 'submitted'`
 * (TC-6/TC-7) — the caller (`DefinitionRequestDetailPage`) only renders the trigger for that
 * combination; the server enforces the same rule independently either way.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  DEFINITION_REQUEST_PRIORITIES,
  updateDefinitionRequestSchema,
  type DefinitionRequest,
  type DefinitionRequestPriority,
  type UpdateDefinitionRequestRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select, type SelectOption } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { useUpdateDefinitionRequestMutation } from './api';

const PRIORITY_OPTIONS: SelectOption[] = DEFINITION_REQUEST_PRIORITIES.map((priority) => ({
  value: priority,
  label: priority[0].toUpperCase() + priority.slice(1),
}));

interface FormValues {
  title: string;
  description: string;
  businessJustification: string;
  priority: DefinitionRequestPriority;
}

export interface EditDefinitionRequestModalProps {
  open: boolean;
  onClose: () => void;
  request: DefinitionRequest;
}

export function EditDefinitionRequestModal({
  open,
  onClose,
  request,
}: EditDefinitionRequestModalProps) {
  const mutation = useUpdateDefinitionRequestMutation(request.id);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const form = useForm<FormValues>({
    defaultValues: {
      title: request.title,
      description: request.description,
      businessJustification: request.businessJustification ?? '',
      priority: request.priority,
    },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      title: request.title,
      description: request.description,
      businessJustification: request.businessJustification ?? '',
      priority: request.priority,
    });
    // Only re-sync when the modal (re)opens for a given request, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [open, request.id]);

  function handleClose(): void {
    setSubmitError(null);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const payload: UpdateDefinitionRequestRequest = {
      title: values.title,
      description: values.description,
      businessJustification:
        values.businessJustification === '' ? null : values.businessJustification,
      priority: values.priority,
    };

    const parsed = updateDefinitionRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'title' || field === 'description') {
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
      title="Edit request"
      description="Only possible while this request is still submitted."
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
          label="Title"
          error={form.formState.errors.title?.message}
          {...form.register('title')}
        />

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="edit-definition-request-description"
            className="text-sm font-medium text-slate-700"
          >
            Description
          </label>
          <textarea
            id="edit-definition-request-description"
            rows={4}
            className="rounded-control border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            {...form.register('description')}
          />
          {form.formState.errors.description && (
            <p className="text-xs text-danger-600">{form.formState.errors.description.message}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="edit-definition-request-justification"
            className="text-sm font-medium text-slate-700"
          >
            Business justification
          </label>
          <textarea
            id="edit-definition-request-justification"
            rows={2}
            className="rounded-control border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            {...form.register('businessJustification')}
          />
        </div>

        <Select
          label="Priority"
          options={PRIORITY_OPTIONS}
          value={form.watch('priority')}
          onChange={(value) => form.setValue('priority', value as DefinitionRequestPriority)}
        />

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
