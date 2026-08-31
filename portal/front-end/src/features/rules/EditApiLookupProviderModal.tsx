/**
 * T-162 — `PATCH /field-api-lookup-providers/:id`. `providerCode` is immutable and never shown
 * as an editable field here (matches `UpdateFieldApiLookupProviderDto`'s own shape).
 *
 * The stored `authConfig` is never returned by any read endpoint (see
 * `AddApiLookupProviderModal.tsx`'s header for why), so this form's JSON textarea always opens
 * blank: leaving it blank on save omits `authConfig` from the request entirely, which
 * `UpdateFieldApiLookupProviderDto`'s own header documents as "leaves the existing one
 * untouched" — there is no way to *read* the current credential back in order to show or merge
 * into it. Typing a new value replaces the stored credential outright.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  updateFieldApiLookupProviderRequestSchema,
  FIELD_API_LOOKUP_AUTH_TYPES,
  FIELD_API_LOOKUP_HTTP_METHODS,
  FIELD_API_LOOKUP_PROVIDER_STATUSES,
  type FieldApiLookupProvider,
  type UpdateFieldApiLookupProviderRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select, type SelectOption } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { useUpdateFieldApiLookupProviderMutation } from './api';

const HTTP_METHOD_OPTIONS: SelectOption[] = FIELD_API_LOOKUP_HTTP_METHODS.map((method) => ({
  value: method,
  label: method,
}));
const AUTH_TYPE_OPTIONS: SelectOption[] = FIELD_API_LOOKUP_AUTH_TYPES.map((type) => ({
  value: type,
  label: type,
}));
const STATUS_OPTIONS: SelectOption[] = FIELD_API_LOOKUP_PROVIDER_STATUSES.map((status) => ({
  value: status,
  label: status,
}));

interface FormValues {
  name: string;
  description: string;
  endpointUrl: string;
  httpMethod: string;
  authType: string;
  responseValueKey: string;
  responseLabelKey: string;
  status: string;
}

function toFormValues(provider: FieldApiLookupProvider): FormValues {
  return {
    name: provider.name,
    description: provider.description ?? '',
    endpointUrl: provider.endpointUrl,
    httpMethod: provider.httpMethod,
    authType: provider.authType,
    responseValueKey: provider.responseValueKey,
    responseLabelKey: provider.responseLabelKey,
    status: provider.status,
  };
}

export interface EditApiLookupProviderModalProps {
  open: boolean;
  onClose: () => void;
  provider: FieldApiLookupProvider;
}

export function EditApiLookupProviderModal({
  open,
  onClose,
  provider,
}: EditApiLookupProviderModalProps) {
  const mutation = useUpdateFieldApiLookupProviderMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [authConfigText, setAuthConfigText] = useState('');
  const [authConfigError, setAuthConfigError] = useState<string | null>(null);

  const form = useForm<FormValues>({ defaultValues: toFormValues(provider) });

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    setAuthConfigText('');
    setAuthConfigError(null);
    form.reset(toFormValues(provider));
    // Only re-sync when the modal (re)opens for a given provider, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [open, provider.id]);

  function handleClose(): void {
    setSubmitError(null);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);
    setAuthConfigError(null);

    let authConfig: Record<string, unknown> | undefined;
    if (authConfigText.trim() !== '') {
      try {
        authConfig = JSON.parse(authConfigText) as Record<string, unknown>;
      } catch {
        setAuthConfigError('Must be valid JSON.');
        return;
      }
    }

    const payload: UpdateFieldApiLookupProviderRequest = {
      name: values.name,
      description: values.description,
      endpointUrl: values.endpointUrl,
      httpMethod: values.httpMethod as UpdateFieldApiLookupProviderRequest['httpMethod'],
      authType: values.authType as UpdateFieldApiLookupProviderRequest['authType'],
      authConfig,
      responseValueKey: values.responseValueKey,
      responseLabelKey: values.responseLabelKey,
      status: values.status as UpdateFieldApiLookupProviderRequest['status'],
    };

    const parsed = updateFieldApiLookupProviderRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (
          field === 'name' ||
          field === 'description' ||
          field === 'endpointUrl' ||
          field === 'responseValueKey' ||
          field === 'responseLabelKey'
        ) {
          form.setError(field, { message: issue.message });
        }
      }
      return;
    }

    try {
      await mutation.mutateAsync({ id: provider.id, input: parsed.data });
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
      title={`Edit ${provider.providerCode}`}
      description="Provider code is immutable."
      size="lg"
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
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="edit-api-lookup-provider-description"
            className="text-sm font-medium text-slate-700"
          >
            Description
          </label>
          <textarea
            id="edit-api-lookup-provider-description"
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
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Endpoint URL"
            error={form.formState.errors.endpointUrl?.message}
            {...form.register('endpointUrl')}
          />
          <Select
            label="HTTP method"
            options={HTTP_METHOD_OPTIONS}
            value={form.watch('httpMethod')}
            onChange={(value) => form.setValue('httpMethod', value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Auth type"
            options={AUTH_TYPE_OPTIONS}
            value={form.watch('authType')}
            onChange={(value) => form.setValue('authType', value)}
          />
          <Select
            label="Status"
            options={STATUS_OPTIONS}
            value={form.watch('status')}
            onChange={(value) => form.setValue('status', value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="edit-api-lookup-provider-auth-config"
            className="text-sm font-medium text-slate-700"
          >
            Auth config (JSON, optional)
          </label>
          <textarea
            id="edit-api-lookup-provider-auth-config"
            rows={3}
            value={authConfigText}
            onChange={(event) => setAuthConfigText(event.target.value)}
            placeholder="Leave blank to keep the existing credential unchanged"
            className="rounded-control border border-slate-300 px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
          />
          {authConfigError && (
            <p role="alert" className="text-xs text-danger-600">
              {authConfigError}
            </p>
          )}
          <p className="text-xs text-slate-500">
            Never shown here — this stays blank whether or not a credential is already stored. Type
            a new JSON object only to replace it.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Response value key"
            error={form.formState.errors.responseValueKey?.message}
            {...form.register('responseValueKey')}
          />
          <Input
            label="Response label key"
            error={form.formState.errors.responseLabelKey?.message}
            {...form.register('responseLabelKey')}
          />
        </div>
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
