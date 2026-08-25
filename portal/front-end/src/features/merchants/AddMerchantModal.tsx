/**
 * T-036 — `POST /merchants`.
 *
 * Validated with the exact schema the back end validates with (`createMerchantRequestSchema`,
 * `packages/shared/src/merchant.schema.ts`) — one Zod schema, both sides, per 00-ARCHITECTURE.md
 * §8. No `tenantId` field anywhere in this form — implementation note 2: it is taken from the
 * actor's own scope server-side, never offered as a choice here. `countryCode` *is* offered —
 * implementation note 3: the server still validates it against the actor's own tenant's country
 * and 400s a mismatch, so this field cannot itself become a scope-escaping input; it exists
 * because `merchants.country_code` has no other source to derive from.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { createMerchantRequestSchema, type Merchant } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/apiError';
import { useCreateMerchantMutation } from './api';

interface FormValues {
  merchantCode: string;
  name: string;
  countryCode: string;
  description: string;
  contactEmail: string;
  contactPhone: string;
  website: string;
}

const DEFAULT_VALUES: FormValues = {
  merchantCode: '',
  name: '',
  countryCode: '',
  description: '',
  contactEmail: '',
  contactPhone: '',
  website: '',
};

/** `zod` issue path → the flat form field it corresponds to. Same technique
 * `AddTenantModal.tsx`'s own `ZOD_PATH_TO_FIELD` documents. */
const ZOD_PATH_TO_FIELD: Record<string, keyof FormValues> = {
  merchantCode: 'merchantCode',
  name: 'name',
  countryCode: 'countryCode',
  description: 'description',
  contactEmail: 'contactEmail',
  contactPhone: 'contactPhone',
  website: 'website',
};

export interface AddMerchantModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddMerchantModal({ open, onClose }: AddMerchantModalProps) {
  const mutation = useCreateMerchantMutation();
  const [result, setResult] = useState<Merchant | null>(null);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });

  function handleClose(): void {
    setResult(null);
    setSubmitError(null);
    form.reset(DEFAULT_VALUES);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const payload = {
      merchantCode: values.merchantCode,
      name: values.name,
      countryCode: values.countryCode,
      description: values.description || undefined,
      contactEmail: values.contactEmail || undefined,
      contactPhone: values.contactPhone || undefined,
      website: values.website || undefined,
    };

    const parsed = createMerchantRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = ZOD_PATH_TO_FIELD[issue.path.join('.')] ?? 'merchantCode';
        form.setError(field, { message: issue.message });
      }
      return;
    }

    try {
      const created = await mutation.mutateAsync(parsed.data);
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
    <Modal
      open={open}
      onClose={handleClose}
      title="Add merchant"
      description="Onboard a new merchant in this tenant."
    >
      {result ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-700">
            <strong>{result.name}</strong> ({result.merchantCode}) has been created, status{' '}
            <strong>{result.status}</strong>.
          </p>
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
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Merchant code"
              placeholder="M001"
              error={form.formState.errors.merchantCode?.message}
              {...form.register('merchantCode')}
            />
            <Input
              label="Country code"
              placeholder="MY"
              maxLength={2}
              error={form.formState.errors.countryCode?.message}
              {...form.register('countryCode')}
            />
          </div>
          <Input
            label="Merchant name"
            placeholder="Acme Retail"
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
          <Input
            label="Description (optional)"
            error={form.formState.errors.description?.message}
            {...form.register('description')}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Contact email (optional)"
              type="email"
              error={form.formState.errors.contactEmail?.message}
              {...form.register('contactEmail')}
            />
            <Input
              label="Contact phone (optional)"
              error={form.formState.errors.contactPhone?.message}
              {...form.register('contactPhone')}
            />
          </div>
          <Input
            label="Website (optional)"
            error={form.formState.errors.website?.message}
            {...form.register('website')}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" isLoading={mutation.isPending}>
              Create merchant
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
