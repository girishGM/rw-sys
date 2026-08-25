/**
 * T-035 — `POST /users`: delegated user creation (03-API-CONTRACT.md §7). The role dropdown is
 * this task's own TC-26/TC-27: it offers **only** the roles the signed-in actor's own role may
 * create, taken from the exact same matrix `UsersService`'s `ALLOWED_CREATION` enforces
 * server-side (`users.service.ts`'s own header carries the full table) — hiding the other five
 * roles is UX, never the control; the server refuses a forged `role` regardless
 * (`AddRuleModal.tsx`'s own header states the same two-independent-controls shape this form
 * repeats).
 *
 * The scope field the actor must supply — `countryId` for a `super_admin`, `tenantId` for a
 * `country_admin`, `merchantId` for a `tenant_admin` creating a `merchant` — is rendered
 * conditionally, one at a time, exactly mirroring `UsersService#deriveTargetScope`'s table.
 * `countryId`/`tenantId` are proper pickers, reusing `features/countries/api.ts` /
 * `features/tenants/api.ts` (both already `done`); `merchantId` is a plain numeric field for now
 * — `features/merchants/**` does not exist yet (T-036, this same agent's very next task, depends
 * on T-035 landing first), so there is no merchant list to pick from. Flagged for the reviewer,
 * the same "primitive now, wired up once the dependency lands" shape
 * `TenantsWithoutCeilingWidget.tsx`'s own header documents for its own forward reference.
 *
 * T-046: the success panel is now `PasswordRevealPanel`, which owns its own gated "Done" button
 * (implementation note 8, TC-20). `handleClose` — the `Modal`'s `onClose`, reached by its ×
 * button, its backdrop click and `Esc` alike — becomes a no-op while the panel is showing and not
 * yet dismissed, so none of those three can bypass the panel's own confirmation checkbox; only
 * `handlePanelDismiss`, wired to the panel's `onDismiss`, actually closes the modal.
 */
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  createUserRequestSchema,
  type CreateUserRequest,
  type UserWithTemporaryPassword,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select, type SelectOption } from '../../components/Select';
import { useBootstrap } from '../../auth/useBootstrap';
import { ApiError } from '../../lib/apiError';
import { useCountriesQuery } from '../countries/api';
import { useTenantsQuery } from '../tenants/api';
import { PasswordRevealPanel } from './PasswordRevealPanel';
import { useCreateUserMutation } from './api';

/** Mirrors `UsersService`'s `ALLOWED_CREATION` (03-API-CONTRACT.md §7). Hiding-only — the server
 * is the actual control. */
const ALLOWED_CREATION: Record<string, readonly string[]> = {
  super_admin: ['country_admin'],
  country_admin: ['tenant_admin'],
  tenant_admin: ['maker', 'checker', 'merchant'],
  maker: [],
  checker: [],
  merchant: [],
};

const ROLE_LABELS: Record<string, string> = {
  country_admin: 'Country Admin',
  tenant_admin: 'Tenant Admin',
  maker: 'Maker',
  checker: 'Checker',
  merchant: 'Merchant',
};

interface FormValues {
  email: string;
  displayName: string;
  role: string;
  countryId: string;
  tenantId: string;
  merchantId: string;
}

const DEFAULT_VALUES: FormValues = {
  email: '',
  displayName: '',
  role: '',
  countryId: '',
  tenantId: '',
  merchantId: '',
};

export interface AddUserModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddUserModal({ open, onClose }: AddUserModalProps) {
  const { user } = useBootstrap();
  const actorRole = user?.role ?? '';

  const mutation = useCreateUserMutation();
  const [result, setResult] = useState<UserWithTemporaryPassword | null>(null);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });
  const role = form.watch('role');

  const roleOptions: SelectOption[] = useMemo(
    () =>
      (ALLOWED_CREATION[actorRole] ?? []).map((value) => ({
        value,
        label: ROLE_LABELS[value] ?? value,
      })),
    [actorRole],
  );

  // Only one of these three ever fetches: each query is enabled solely for the actor role that
  // needs it (TC-26/TC-27 — the same role-gated dropdown, applied to the scope picker too).
  const countriesQuery = useCountriesQuery({ pageSize: 100 });
  const tenantsQuery = useTenantsQuery({ pageSize: 100 });

  const countryOptions: SelectOption[] = useMemo(
    () =>
      (countriesQuery.data?.data ?? []).map((country) => ({
        value: String(country.id),
        label: `${country.name} (${country.code})`,
      })),
    [countriesQuery.data],
  );

  const tenantOptions: SelectOption[] = useMemo(
    () =>
      (tenantsQuery.data?.data ?? []).map((tenant) => ({
        value: String(tenant.id),
        label: `${tenant.name} (${tenant.code})`,
      })),
    [tenantsQuery.data],
  );

  function handleClose(): void {
    // T-046 TC-20: while the one-time password panel is showing, the modal's own ×/backdrop/Esc
    // must not be able to dismiss it — only the panel's own gated "Done" button can, via
    // `handlePanelDismiss` below.
    if (result !== null) return;
    setSubmitError(null);
    form.reset(DEFAULT_VALUES);
    onClose();
  }

  function handlePanelDismiss(): void {
    setResult(null);
    setSubmitError(null);
    form.reset(DEFAULT_VALUES);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const payload: CreateUserRequest = {
      email: values.email,
      displayName: values.displayName,
      role: values.role as CreateUserRequest['role'],
      countryId: values.countryId === '' ? undefined : Number(values.countryId),
      tenantId: values.tenantId === '' ? undefined : Number(values.tenantId),
      merchantId: values.merchantId === '' ? undefined : Number(values.merchantId),
    };

    const parsed = createUserRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (
          field === 'email' ||
          field === 'displayName' ||
          field === 'role' ||
          field === 'countryId' ||
          field === 'tenantId' ||
          field === 'merchantId'
        ) {
          form.setError(field, { message: issue.message });
        }
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
    <Modal open={open} onClose={handleClose} title="Add user" size="sm">
      {result ? (
        <PasswordRevealPanel
          email={result.email}
          temporaryPassword={result.temporaryPassword}
          action="created"
          onDismiss={handlePanelDismiss}
        />
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
          <Select
            label="Role"
            options={roleOptions}
            value={role === '' ? null : role}
            onChange={(value) => form.setValue('role', value)}
            error={form.formState.errors.role?.message}
          />
          <Input
            label="Email"
            type="email"
            error={form.formState.errors.email?.message}
            {...form.register('email')}
          />
          <Input
            label="Display name"
            error={form.formState.errors.displayName?.message}
            {...form.register('displayName')}
          />
          {actorRole === 'super_admin' && (
            <Select
              label="Country"
              options={countryOptions}
              value={form.watch('countryId') === '' ? null : form.watch('countryId')}
              onChange={(value) => form.setValue('countryId', value)}
              error={form.formState.errors.countryId?.message}
            />
          )}
          {actorRole === 'country_admin' && (
            <Select
              label="Tenant"
              options={tenantOptions}
              value={form.watch('tenantId') === '' ? null : form.watch('tenantId')}
              onChange={(value) => form.setValue('tenantId', value)}
              error={form.formState.errors.tenantId?.message}
            />
          )}
          {actorRole === 'tenant_admin' && role === 'merchant' && (
            <Input
              label="Merchant ID"
              type="number"
              error={form.formState.errors.merchantId?.message}
              {...form.register('merchantId')}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" isLoading={mutation.isPending}>
              Create user
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
