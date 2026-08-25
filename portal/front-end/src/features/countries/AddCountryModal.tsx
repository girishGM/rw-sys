/**
 * T-030 — `POST /countries`, with the optional inline Country Admin step
 * (04-FRONTEND.md, Countries list/detail row: "Onboard country → then 'Create Country Admin' as
 * an inline next step").
 *
 * Validated with the exact schema the back end validates with (`createCountryRequestSchema`,
 * `packages/shared/src/country.schema.ts`) — one Zod schema, both sides, per 00-ARCHITECTURE.md
 * §8. Applied by hand in `onSubmit` rather than via `zodResolver` because the form's flat
 * `adminEmail`/`adminDisplayName` fields (react-hook-form has no first-class nested-toggle
 * ergonomics worth fighting here) do not share the schema's nested `admin.email` shape —
 * {@link ZOD_PATH_TO_FIELD} is the one place that mapping is declared.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { createCountryRequestSchema, type CreateCountryResponse } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Toggle } from '../../components/Toggle';
import { ApiError } from '../../lib/apiError';
import { useCreateCountryMutation } from './api';
import { TemporaryPasswordReveal } from './TemporaryPasswordReveal';

interface FormValues {
  code: string;
  name: string;
  timezone: string;
  currencyCode: string;
  dialingCode: string;
  isHq: boolean;
  onboardAdmin: boolean;
  adminEmail: string;
  adminDisplayName: string;
}

const DEFAULT_VALUES: FormValues = {
  code: '',
  name: '',
  timezone: '',
  currencyCode: '',
  dialingCode: '',
  isHq: false,
  onboardAdmin: false,
  adminEmail: '',
  adminDisplayName: '',
};

/** `zod` issue path (dotted) → the flat form field it corresponds to. See the file header. */
const ZOD_PATH_TO_FIELD: Record<string, keyof FormValues> = {
  code: 'code',
  name: 'name',
  timezone: 'timezone',
  currencyCode: 'currencyCode',
  dialingCode: 'dialingCode',
  isHq: 'isHq',
  'admin.email': 'adminEmail',
  'admin.displayName': 'adminDisplayName',
};

export interface AddCountryModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddCountryModal({ open, onClose }: AddCountryModalProps) {
  const mutation = useCreateCountryMutation();
  const [result, setResult] = useState<CreateCountryResponse | null>(null);
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
      timezone: values.timezone,
      currencyCode: values.currencyCode,
      dialingCode: values.dialingCode,
      isHq: values.isHq,
      admin: values.onboardAdmin
        ? { email: values.adminEmail, displayName: values.adminDisplayName }
        : undefined,
    };

    const parsed = createCountryRequestSchema.safeParse(payload);
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
      title="Add country"
      description="Onboard a new country, and optionally its first Country Admin, in one step."
    >
      {result ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-700">
            <strong>{result.country.name}</strong> ({result.country.code}) has been created.
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
              label="ISO country code"
              placeholder="MY"
              maxLength={2}
              error={form.formState.errors.code?.message}
              {...form.register('code')}
            />
            <Input
              label="Currency code"
              placeholder="MYR"
              maxLength={3}
              error={form.formState.errors.currencyCode?.message}
              {...form.register('currencyCode')}
            />
          </div>
          <Input
            label="Country name"
            placeholder="Malaysia"
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Timezone (IANA)"
              placeholder="Asia/Kuala_Lumpur"
              error={form.formState.errors.timezone?.message}
              {...form.register('timezone')}
            />
            <Input
              label="Dialing code"
              placeholder="+60"
              error={form.formState.errors.dialingCode?.message}
              {...form.register('dialingCode')}
            />
          </div>
          <Toggle
            label="This is the HQ country"
            checked={form.watch('isHq')}
            onChange={(checked) => form.setValue('isHq', checked)}
          />
          <Toggle
            label="Onboard the Country Admin now"
            checked={onboardAdmin}
            onChange={(checked) => form.setValue('onboardAdmin', checked)}
          />
          {onboardAdmin && (
            <div className="flex flex-col gap-4 rounded-card border border-slate-200 p-4">
              <Input
                label="Country Admin email"
                type="email"
                error={form.formState.errors.adminEmail?.message}
                {...form.register('adminEmail')}
              />
              <Input
                label="Country Admin name"
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
              Create country
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
