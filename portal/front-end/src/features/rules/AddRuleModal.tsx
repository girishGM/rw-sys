/**
 * T-031 — `POST /rules` (04-FRONTEND.md §4: "Category → sub-category → expression + parameter
 * schema builder").
 *
 * Validated with the exact schema the back end validates with (`createRuleRequestSchema`,
 * `packages/shared/src/rule.schema.ts`) — one Zod schema, both sides, per 00-ARCHITECTURE.md §8.
 * `expression` is passed through untouched, never evaluated here or anywhere else in the portal
 * (implementation note 5) — this form is a plain text box, not an expression builder.
 */
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  createRuleRequestSchema,
  type CreateRuleRequest,
  type RuleParameterField,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select, type SelectOption } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { ParameterFieldsEditor } from './ParameterFieldsEditor';
import {
  useCreateRuleMutation,
  useFieldApiLookupProvidersQuery,
  useFieldContextProvidersQuery,
  useRuleCategoriesQuery,
  useRuleResolversQuery,
  useRuleSubCategoriesQuery,
} from './api';

interface FormValues {
  categoryId: string;
  subCategoryId: string;
  ruleCode: string;
  name: string;
  expression: string;
}

const DEFAULT_VALUES: FormValues = {
  categoryId: '',
  subCategoryId: '',
  ruleCode: '',
  name: '',
  expression: '',
};

export interface AddRuleModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddRuleModal({ open, onClose }: AddRuleModalProps) {
  const mutation = useCreateRuleMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [fields, setFields] = useState<RuleParameterField[]>([]);
  // T-115 — which Resolver's `resolverInputFieldKeys` the field builder previews the "Resolver
  // input" / "Compared value" badge against. Never submitted (implementation note 3): the
  // request payload built in `onSubmit` below has no `resolverId`/`role` key at all, matching
  // `createRuleRequestSchema`, which does not accept either.
  const [previewResolverId, setPreviewResolverId] = useState<string>('');

  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });
  const categoryId = form.watch('categoryId');

  const categoriesQuery = useRuleCategoriesQuery();
  const subCategoriesQuery = useRuleSubCategoriesQuery(
    categoryId === '' ? undefined : Number(categoryId),
  );
  const resolversQuery = useRuleResolversQuery();
  // T-125 — feeds the field builder's "Where do the options come from?" picker.
  const contextProvidersQuery = useFieldContextProvidersQuery();
  const apiLookupProvidersQuery = useFieldApiLookupProvidersQuery();

  const categoryOptions: SelectOption[] = useMemo(
    () =>
      (categoriesQuery.data ?? []).map((category) => ({
        value: String(category.id),
        label: category.name,
      })),
    [categoriesQuery.data],
  );

  const subCategoryOptions: SelectOption[] = useMemo(
    () =>
      (subCategoriesQuery.data ?? [])
        .filter((subCategory) => categoryId === '' || subCategory.categoryId === Number(categoryId))
        .map((subCategory) => ({ value: String(subCategory.id), label: subCategory.name })),
    [subCategoriesQuery.data, categoryId],
  );

  const resolverOptions: SelectOption[] = useMemo(
    () =>
      (resolversQuery.data ?? []).map((resolver) => ({
        value: String(resolver.id),
        label: `${resolver.name} (${resolver.resolverCode})`,
      })),
    [resolversQuery.data],
  );

  // T-115 — the previewed Resolver's `resolverInputFieldKeys`, or `[]` (every field reads as
  // "Compared value") when none is selected — computed client-side, purely from the already-
  // fetched `GET /rule-resolvers` list, so recomputing per keystroke costs no extra request.
  const previewResolverInputFieldKeys: readonly string[] = useMemo(
    () =>
      (resolversQuery.data ?? []).find((resolver) => String(resolver.id) === previewResolverId)
        ?.resolverInputFieldKeys ?? [],
    [resolversQuery.data, previewResolverId],
  );

  function handleClose(): void {
    setSubmitError(null);
    setFields([]);
    setPreviewResolverId('');
    form.reset(DEFAULT_VALUES);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const payload: CreateRuleRequest = {
      ruleCode: values.ruleCode,
      name: values.name,
      subCategoryId: Number(values.subCategoryId),
      expression: values.expression === '' ? undefined : values.expression,
      parameters: fields.length > 0 ? { fields } : undefined,
    };

    const parsed = createRuleRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (
          field === 'ruleCode' ||
          field === 'name' ||
          field === 'subCategoryId' ||
          field === 'expression'
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
      title="Add rule"
      description="Author a new global rule."
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
          <Select
            label="Category"
            options={categoryOptions}
            value={categoryId === '' ? null : categoryId}
            onChange={(value) => {
              form.setValue('categoryId', value);
              form.setValue('subCategoryId', '');
            }}
          />
          <Select
            label="Sub-category"
            options={subCategoryOptions}
            value={form.watch('subCategoryId') === '' ? null : form.watch('subCategoryId')}
            onChange={(value) => form.setValue('subCategoryId', value)}
            disabled={categoryId === ''}
            error={form.formState.errors.subCategoryId?.message}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Rule code"
            placeholder="MIN_SPEND_TIER"
            error={form.formState.errors.ruleCode?.message}
            {...form.register('ruleCode')}
          />
          <Input
            label="Name"
            placeholder="Minimum spend tier"
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="rule-expression" className="text-sm font-medium text-slate-700">
            Expression
          </label>
          <textarea
            id="rule-expression"
            rows={3}
            className="rounded-control border border-slate-300 px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            placeholder="amount >= :minSpend"
            {...form.register('expression')}
          />
          <p className="text-xs text-slate-500">
            Stored as text and passed to the rules engine as-is — never evaluated by the portal.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Select
            label="Resolver (preview)"
            options={resolverOptions}
            value={previewResolverId === '' ? null : previewResolverId}
            onChange={setPreviewResolverId}
            placeholder="None — every field is Compared value"
          />
          <p className="text-xs text-slate-500">
            Not saved with this rule — wiring a rule to a resolver happens separately, on its
            version. Pick one here only to preview which parameter keys it would treat as its own
            input.
          </p>
        </div>

        <ParameterFieldsEditor
          fields={fields}
          onChange={setFields}
          resolverInputFieldKeys={previewResolverInputFieldKeys}
          contextProviders={contextProvidersQuery.data ?? []}
          apiLookupProviders={apiLookupProvidersQuery.data ?? []}
        />

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={mutation.isPending}>
            Create rule
          </Button>
        </div>
      </form>
    </Modal>
  );
}
