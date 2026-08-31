/**
 * T-162 — `POST /field-api-lookup-providers`. Super Admin only, server-enforced (same layered
 * guard `AddContextProviderModal.tsx`'s header documents).
 *
 * `authConfig` is entered as a JSON object, the same pattern `EditVersionDraftModal.tsx`'s
 * `resolverConfigText` field uses for a free-form, `authType`-dependent shape. Plaintext here on
 * the way in only — `field-value-source.schema.ts`'s own header explains why it is encrypted
 * before storage and never returned by any read endpoint. Left blank, no credential is stored
 * and the provider defaults to `planned` (`CreateFieldApiLookupProviderDto`'s own header: the
 * safe default for "nobody has confirmed this endpoint yet" is the one that makes T-123 decline
 * a runtime lookup rather than attempt an unverified call).
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  createFieldApiLookupProviderRequestSchema,
  FIELD_API_LOOKUP_AUTH_TYPES,
  FIELD_API_LOOKUP_HTTP_METHODS,
  FIELD_API_LOOKUP_PROVIDER_STATUSES,
  type CreateFieldApiLookupProviderRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select, type SelectOption } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { useCreateFieldApiLookupProviderMutation } from './api';

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
  providerCode: string;
  name: string;
  description: string;
  endpointUrl: string;
  httpMethod: string;
  authType: string;
  responseValueKey: string;
  responseLabelKey: string;
  status: string;
}

const DEFAULT_VALUES: FormValues = {
  providerCode: '',
  name: '',
  description: '',
  endpointUrl: '',
  httpMethod: 'GET',
  authType: 'none',
  responseValueKey: '',
  responseLabelKey: '',
  status: 'planned',
};

export interface AddApiLookupProviderModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddApiLookupProviderModal({ open, onClose }: AddApiLookupProviderModalProps) {
  const mutation = useCreateFieldApiLookupProviderMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [authConfigText, setAuthConfigText] = useState('');
  const [authConfigError, setAuthConfigError] = useState<string | null>(null);
  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });

  function handleClose(): void {
    setSubmitError(null);
    setAuthConfigText('');
    setAuthConfigError(null);
    form.reset(DEFAULT_VALUES);
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

    const payload: CreateFieldApiLookupProviderRequest = {
      providerCode: values.providerCode,
      name: values.name,
      description: values.description === '' ? undefined : values.description,
      endpointUrl: values.endpointUrl,
      httpMethod: values.httpMethod as CreateFieldApiLookupProviderRequest['httpMethod'],
      authType: values.authType as CreateFieldApiLookupProviderRequest['authType'],
      authConfig,
      responseValueKey: values.responseValueKey,
      responseLabelKey: values.responseLabelKey,
      status: values.status as CreateFieldApiLookupProviderRequest['status'],
    };

    const parsed = createFieldApiLookupProviderRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (
          field === 'providerCode' ||
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
      title="Add API lookup provider"
      description="A 'live lookup' value source a rule's parameter field can point at."
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
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Provider code"
            placeholder="PRODUCT_CATALOG"
            hint="Upper snake case, e.g. PRODUCT_CATALOG. Immutable once created."
            error={form.formState.errors.providerCode?.message}
            {...form.register('providerCode')}
          />
          <Input
            label="Name"
            placeholder="Product catalog service"
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="add-api-lookup-provider-description"
            className="text-sm font-medium text-slate-700"
          >
            Description
          </label>
          <textarea
            id="add-api-lookup-provider-description"
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
            placeholder="https://internal.example.com/catalog"
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
            htmlFor="add-api-lookup-provider-auth-config"
            className="text-sm font-medium text-slate-700"
          >
            Auth config (JSON, optional)
          </label>
          <textarea
            id="add-api-lookup-provider-auth-config"
            rows={3}
            value={authConfigText}
            onChange={(event) => setAuthConfigText(event.target.value)}
            placeholder='{"headerName": "X-Api-Key", "apiKey": "..."}'
            className="rounded-control border border-slate-300 px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
          />
          {authConfigError && (
            <p role="alert" className="text-xs text-danger-600">
              {authConfigError}
            </p>
          )}
          <p className="text-xs text-slate-500">Encrypted at rest. Never shown again once saved.</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Response value key"
            placeholder="productId"
            error={form.formState.errors.responseValueKey?.message}
            {...form.register('responseValueKey')}
          />
          <Input
            label="Response label key"
            placeholder="productName"
            error={form.formState.errors.responseLabelKey?.message}
            {...form.register('responseLabelKey')}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={mutation.isPending}>
            Create provider
          </Button>
        </div>
      </form>
    </Modal>
  );
}
