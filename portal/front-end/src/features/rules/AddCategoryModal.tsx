/**
 * T-107 — `POST /rule-categories`. Follows `AddRuleModal.tsx`'s exact shape: `react-hook-form` +
 * the shared Zod schema via `safeParse`, `ApiError` rendered as a `role="alert"` paragraph.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  createRuleCategoryRequestSchema,
  type CreateRuleCategoryRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/apiError';
import { useCreateRuleCategoryMutation } from './api';

const DEFAULT_VALUES: CreateRuleCategoryRequest = { categoryCode: '', name: '' };

export interface AddCategoryModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddCategoryModal({ open, onClose }: AddCategoryModalProps) {
  const mutation = useCreateRuleCategoryMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const form = useForm<CreateRuleCategoryRequest>({ defaultValues: DEFAULT_VALUES });

  function handleClose(): void {
    setSubmitError(null);
    form.reset(DEFAULT_VALUES);
    onClose();
  }

  async function onSubmit(values: CreateRuleCategoryRequest): Promise<void> {
    setSubmitError(null);

    const parsed = createRuleCategoryRequestSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'categoryCode' || field === 'name') {
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
      title="Add category"
      description="Top-level grouping for rule sub-categories."
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
          label="Category code"
          placeholder="FRAUD_SIGNAL"
          error={form.formState.errors.categoryCode?.message}
          {...form.register('categoryCode')}
        />
        <Input
          label="Name"
          placeholder="Fraud Signal Rules"
          error={form.formState.errors.name?.message}
          {...form.register('name')}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={mutation.isPending}>
            Create category
          </Button>
        </div>
      </form>
    </Modal>
  );
}
