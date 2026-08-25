/**
 * T-036 — `POST /merchants/:id/stores` (TC-12).
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { createMerchantStoreRequestSchema } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/apiError';
import { useCreateStoreMutation } from './api';

interface FormValues {
  storeCode: string;
  name: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  region: string;
  latitude: string;
  longitude: string;
}

const DEFAULT_VALUES: FormValues = {
  storeCode: '',
  name: '',
  address: '',
  city: '',
  state: '',
  postalCode: '',
  region: '',
  latitude: '',
  longitude: '',
};

const ZOD_PATH_TO_FIELD: Record<string, keyof FormValues> = {
  storeCode: 'storeCode',
  name: 'name',
  address: 'address',
  city: 'city',
  state: 'state',
  postalCode: 'postalCode',
  region: 'region',
  latitude: 'latitude',
  longitude: 'longitude',
};

export interface AddMerchantStoreModalProps {
  open: boolean;
  onClose: () => void;
  merchantId: number;
}

export function AddMerchantStoreModal({ open, onClose, merchantId }: AddMerchantStoreModalProps) {
  const mutation = useCreateStoreMutation(merchantId);
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
      storeCode: values.storeCode,
      name: values.name,
      address: values.address || undefined,
      city: values.city || undefined,
      state: values.state || undefined,
      postalCode: values.postalCode || undefined,
      region: values.region || undefined,
      latitude: values.latitude === '' ? undefined : Number(values.latitude),
      longitude: values.longitude === '' ? undefined : Number(values.longitude),
    };

    const parsed = createMerchantStoreRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = ZOD_PATH_TO_FIELD[issue.path.join('.')] ?? 'storeCode';
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
      title="Add store"
      description="Add a store to this merchant."
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
            label="Store code"
            placeholder="S001"
            error={form.formState.errors.storeCode?.message}
            {...form.register('storeCode')}
          />
          <Input
            label="Store name"
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
        </div>
        <Input
          label="Address (optional)"
          error={form.formState.errors.address?.message}
          {...form.register('address')}
        />
        <div className="grid grid-cols-3 gap-4">
          <Input
            label="City (optional)"
            error={form.formState.errors.city?.message}
            {...form.register('city')}
          />
          <Input
            label="State (optional)"
            error={form.formState.errors.state?.message}
            {...form.register('state')}
          />
          <Input
            label="Postal code (optional)"
            error={form.formState.errors.postalCode?.message}
            {...form.register('postalCode')}
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Input
            label="Region (optional)"
            error={form.formState.errors.region?.message}
            {...form.register('region')}
          />
          <Input
            label="Latitude (optional)"
            inputMode="decimal"
            error={form.formState.errors.latitude?.message}
            {...form.register('latitude')}
          />
          <Input
            label="Longitude (optional)"
            inputMode="decimal"
            error={form.formState.errors.longitude?.message}
            {...form.register('longitude')}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={mutation.isPending}>
            Add store
          </Button>
        </div>
      </form>
    </Modal>
  );
}
