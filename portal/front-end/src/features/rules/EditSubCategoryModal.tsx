/**
 * T-107 — `PATCH /rule-sub-categories/:id`. `subCategoryCode`/`categoryId` are immutable — not
 * editable here.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  updateRuleSubCategoryRequestSchema,
  type RuleSubCategory,
  type UpdateRuleSubCategoryRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { useUpdateRuleSubCategoryMutation } from './api';

export interface EditSubCategoryModalProps {
  open: boolean;
  onClose: () => void;
  subCategory: RuleSubCategory;
}

/** `subCategory.status` is a plain `string` at the DTO boundary — narrowed here since this
 * form only ever offers the two real values below. */
function asStatus(value: string): 'active' | 'inactive' {
  return value === 'inactive' ? 'inactive' : 'active';
}

export function EditSubCategoryModal({ open, onClose, subCategory }: EditSubCategoryModalProps) {
  const mutation = useUpdateRuleSubCategoryMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const form = useForm<UpdateRuleSubCategoryRequest>({
    defaultValues: { name: subCategory.name, status: asStatus(subCategory.status) },
  });

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    form.reset({ name: subCategory.name, status: asStatus(subCategory.status) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync only on open/target change
  }, [open, subCategory.id]);

  function handleClose(): void {
    onClose();
  }

  async function onSubmit(values: UpdateRuleSubCategoryRequest): Promise<void> {
    setSubmitError(null);

    const parsed = updateRuleSubCategoryRequestSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'name' || field === 'status')
          form.setError(field, { message: issue.message });
      }
      return;
    }

    try {
      await mutation.mutateAsync({ id: subCategory.id, input: parsed.data });
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
      title={`Edit sub-category — ${subCategory.subCategoryCode}`}
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
          label="Name"
          error={form.formState.errors.name?.message}
          {...form.register('name')}
        />
        <Select
          label="Status"
          value={form.watch('status') ?? asStatus(subCategory.status)}
          onChange={(value) => form.setValue('status', asStatus(value))}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]}
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
