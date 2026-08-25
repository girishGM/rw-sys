/**
 * T-036 — `POST /merchants/:id/activities` (TC-14/TC-16/TC-17/TC-18/TC-19).
 *
 * `activityId`/`storeId` are plain numeric-id inputs, not pickers — there is no `/activities`
 * catalogue endpoint anywhere in this codebase yet for a dropdown to call (grepped across every
 * `back-end/src/modules/**` at the time this screen was built; `reward_config.activities` has no
 * REST surface of its own). Flagged for the reviewer/architect: a future task that adds one
 * should widen this field to a search-select, the same shape `MultiSelect`/`Select` already give
 * every other id picker in this portal. `storeId` reuses this merchant's own stores, listed on
 * the same detail page this modal is opened from, so a user can read off the id from the Stores
 * tab today.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { createMerchantActivityRequestSchema } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/apiError';
import { useCreateActivityMutation } from './api';

interface FormValues {
  activityId: string;
  storeId: string;
  commissionRate: string;
}

const DEFAULT_VALUES: FormValues = { activityId: '', storeId: '', commissionRate: '' };

const ZOD_PATH_TO_FIELD: Record<string, keyof FormValues> = {
  activityId: 'activityId',
  storeId: 'storeId',
  commissionRate: 'commissionRate',
};

export interface AddMerchantActivityModalProps {
  open: boolean;
  onClose: () => void;
  merchantId: number;
}

export function AddMerchantActivityModal({
  open,
  onClose,
  merchantId,
}: AddMerchantActivityModalProps) {
  const mutation = useCreateActivityMutation(merchantId);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });

  function handleClose(): void {
    setSubmitError(null);
    form.reset(DEFAULT_VALUES);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const payload = {
      activityId: Number(values.activityId),
      storeId: values.storeId === '' ? undefined : Number(values.storeId),
      commissionRate: values.commissionRate === '' ? undefined : Number(values.commissionRate),
    };

    const parsed = createMerchantActivityRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = ZOD_PATH_TO_FIELD[issue.path.join('.')] ?? 'activityId';
        form.setError(field, { message: issue.message });
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
      title="Link activity"
      description="Link an activity to this merchant — tenant-wide, or to one of its stores."
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
          label="Activity id"
          inputMode="numeric"
          error={form.formState.errors.activityId?.message}
          {...form.register('activityId')}
        />
        <Input
          label="Store id (optional — leave blank for tenant-wide)"
          inputMode="numeric"
          hint="Omit to link this activity across every store; supply a store id to scope it to one store."
          error={form.formState.errors.storeId?.message}
          {...form.register('storeId')}
        />
        <Input
          label="Commission rate % (optional, 0-100, up to 2 decimals)"
          inputMode="decimal"
          error={form.formState.errors.commissionRate?.message}
          {...form.register('commissionRate')}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={mutation.isPending}>
            Link activity
          </Button>
        </div>
      </form>
    </Modal>
  );
}
