/**
 * T-034 — `POST /tenants`, with the optional inline Tenant Admin step
 * (04-FRONTEND.md, Tenants list/detail row: "Onboard tenant → then 'Create Tenant Admin' as an
 * inline next step" — the tenant-level mirror of `AddCountryModal.tsx`).
 *
 * Validated with the exact schema the back end validates with (`createTenantRequestSchema`,
 * `packages/shared/src/tenant.schema.ts`) — one Zod schema, both sides, per 00-ARCHITECTURE.md
 * §8. No `countryId` field anywhere in this form — implementation note 2: it is taken from the
 * actor's own scope server-side, never offered as a choice here.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { createTenantRequestSchema, type CreateTenantResponse } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Toggle } from '../../components/Toggle';
import { ApiError } from '../../lib/apiError';
import { useCreateTenantMutation } from './api';
import { TemporaryPasswordReveal } from './TemporaryPasswordReveal';

interface FormValues {
  code: string;
  name: string;
  schemaPrefix: string;
  contactEmail: string;
  contactPhone: string;
  onboardAdmin: boolean;
  adminEmail: string;
  adminDisplayName: string;
}

const DEFAULT_VALUES: FormValues = {
  code: '',
  name: '',
  schemaPrefix: '',
  contactEmail: '',
  contactPhone: '',
  onboardAdmin: false,
  adminEmail: '',
  adminDisplayName: '',
};

/** `zod` issue path (dotted) → the flat form field it corresponds to. Same technique
 * `AddCountryModal.tsx`'s own `ZOD_PATH_TO_FIELD` documents. */
const ZOD_PATH_TO_FIELD: Record<string, keyof FormValues> = {
  code: 'code',
  name: 'name',
  schemaPrefix: 'schemaPrefix',
  contactEmail: 'contactEmail',
  contactPhone: 'contactPhone',
  'admin.email': 'adminEmail',
  'admin.displayName': 'adminDisplayName',
};

export interface AddTenantModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddTenantModal({ open, onClose }: AddTenantModalProps) {
  const mutation = useCreateTenantMutation();
  const [result, setResult] = useState<CreateTenantResponse | null>(null);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });
  const onboardAdmin = form.watch('onboardAdmin');

  function handleClose(): void {
    setResult(null);
    setSubmitError(null);
    form.reset(DEFAULT_VALUES);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const payload = {
      code: values.code,
      name: values.name,
      schemaPrefix: values.schemaPrefix || undefined,
      contactEmail: values.contactEmail || undefined,
      contactPhone: values.contactPhone || undefined,
      admin: values.onboardAdmin
        ? { email: values.adminEmail, displayName: values.adminDisplayName }
        : undefined,
    };

    const parsed = createTenantRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = ZOD_PATH_TO_FIELD[issue.path.join('.')] ?? 'code';
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
      title="Add tenant"
      description="Onboard a new tenant in your country, and optionally its first Tenant Admin, in one step."
    >
      {result ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-700">
            <strong>{result.tenant.name}</strong> ({result.tenant.code}) has been created, status{' '}
            <strong>{result.tenant.status}</strong>.
          </p>
          {result.admin && (
            <TemporaryPasswordReveal
              email={result.admin.email}
              temporaryPassword={result.admin.temporaryPassword}
            />
          )}
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
              label="Tenant code"
              placeholder="T001"
              error={form.formState.errors.code?.message}
              {...form.register('code')}
            />
            <Input
              label="Schema prefix (optional)"
              placeholder="acme"
              error={form.formState.errors.schemaPrefix?.message}
              {...form.register('schemaPrefix')}
            />
          </div>
          <Input
            label="Tenant name"
            placeholder="Acme Retail"
            error={form.formState.errors.name?.message}
            {...form.register('name')}
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
          <Toggle
            label="Onboard the Tenant Admin now"
            checked={onboardAdmin}
            onChange={(checked) => form.setValue('onboardAdmin', checked)}
          />
          {onboardAdmin && (
            <div className="flex flex-col gap-4 rounded-card border border-slate-200 p-4">
              <Input
                label="Tenant Admin email"
                type="email"
                error={form.formState.errors.adminEmail?.message}
                {...form.register('adminEmail')}
              />
              <Input
                label="Tenant Admin name"
                error={form.formState.errors.adminDisplayName?.message}
                {...form.register('adminDisplayName')}
              />
              <p className="text-xs text-slate-500">
                A temporary password is generated automatically and shown once — nobody chooses it.
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" isLoading={mutation.isPending}>
              Create tenant
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
