/**
 * T-107 — `POST /rule-sub-categories`. Opened either from the page-level "+ Add sub-category"
 * (no category pre-selected) or from a specific category's row (`defaultCategoryId` set) —
 * same cascading-dropdown pattern `AddRuleModal.tsx` uses for category → sub-category, just
 * inverted (there is no sub-category-of-sub-category level to cascade into here).
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { RuleCategory } from '@reward-portal/shared';
import {
  createRuleSubCategoryRequestSchema,
  type CreateRuleSubCategoryRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select, type SelectOption } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { useCreateRuleSubCategoryMutation } from './api';

export interface AddSubCategoryModalProps {
  open: boolean;
  onClose: () => void;
  categories: readonly RuleCategory[];
  defaultCategoryId?: number;
}

export function AddSubCategoryModal({
  open,
  onClose,
  categories,
  defaultCategoryId,
}: AddSubCategoryModalProps) {
  const mutation = useCreateRuleSubCategoryMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [categoryId, setCategoryId] = useState<string>(
    defaultCategoryId === undefined ? '' : String(defaultCategoryId),
  );
  const form = useForm<{ subCategoryCode: string; name: string }>({
    defaultValues: { subCategoryCode: '', name: '' },
  });

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    setCategoryId(defaultCategoryId === undefined ? '' : String(defaultCategoryId));
    form.reset({ subCategoryCode: '', name: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync only on open/target change
  }, [open, defaultCategoryId]);

  const categoryOptions: SelectOption[] = categories.map((c) => ({
    value: String(c.id),
    label: c.name,
  }));

  function handleClose(): void {
    onClose();
  }

  async function onSubmit(values: { subCategoryCode: string; name: string }): Promise<void> {
    setSubmitError(null);

    const payload: CreateRuleSubCategoryRequest = {
      categoryId: Number(categoryId),
      subCategoryCode: values.subCategoryCode,
      name: values.name,
    };
    const parsed = createRuleSubCategoryRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'subCategoryCode' || field === 'name') {
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
      title="Add sub-category"
      description="Groups rules within a category for the Rule Master picker."
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
        <Select
          label="Category"
          value={categoryId === '' ? null : categoryId}
          onChange={setCategoryId}
          options={categoryOptions}
        />
        <Input
          label="Sub-category code"
          placeholder="VELOCITY_CHECK"
          error={form.formState.errors.subCategoryCode?.message}
          {...form.register('subCategoryCode')}
        />
        <Input
          label="Name"
          placeholder="Velocity Check"
          error={form.formState.errors.name?.message}
          {...form.register('name')}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={mutation.isPending} disabled={categoryId === ''}>
            Create sub-category
          </Button>
        </div>
      </form>
    </Modal>
  );
}
