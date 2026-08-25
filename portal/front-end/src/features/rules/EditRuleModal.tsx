/**
 * T-031 — `PATCH /rules/:id`. `ruleCode` is immutable and never shown as an editable field here
 * (matches `UpdateRuleDto`'s own shape — the back end does not accept it either).
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  updateRuleRequestSchema,
  type Rule,
  type RuleParameterField,
  type UpdateRuleRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select, type SelectOption } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { ParameterFieldsEditor } from './ParameterFieldsEditor';
import { useRuleSubCategoriesQuery, useUpdateRuleMutation } from './api';

const STATUS_OPTIONS: SelectOption[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

interface FormValues {
  name: string;
  subCategoryId: string;
  expression: string;
  status: string;
}

export interface EditRuleModalProps {
  open: boolean;
  onClose: () => void;
  rule: Rule;
}

export function EditRuleModal({ open, onClose, rule }: EditRuleModalProps) {
  const mutation = useUpdateRuleMutation(rule.id);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [fields, setFields] = useState<RuleParameterField[]>(rule.parameters.fields);

  const form = useForm<FormValues>({
    defaultValues: {
      name: rule.name,
      subCategoryId: String(rule.subCategoryId),
      expression: rule.expression ?? '',
      status: rule.status,
    },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      name: rule.name,
      subCategoryId: String(rule.subCategoryId),
      expression: rule.expression ?? '',
      status: rule.status,
    });
    setFields(rule.parameters.fields);
    // Only re-sync when the modal (re)opens for a given rule, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [open, rule.id]);

  const subCategoriesQuery = useRuleSubCategoriesQuery(undefined);
  const subCategoryOptions: SelectOption[] = (subCategoriesQuery.data ?? []).map((subCategory) => ({
    value: String(subCategory.id),
    label: `${subCategory.name} (${subCategory.subCategoryCode})`,
  }));

  function handleClose(): void {
    setSubmitError(null);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const payload: UpdateRuleRequest = {
      name: values.name,
      subCategoryId: Number(values.subCategoryId),
      expression: values.expression === '' ? null : values.expression,
      parameters: { fields },
      status:
        values.status === 'active' || values.status === 'inactive' ? values.status : undefined,
    };

    const parsed = updateRuleRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'name' || field === 'subCategoryId' || field === 'expression') {
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
      title={`Edit ${rule.ruleCode}`}
      description="Rule code is immutable."
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
            label="Name"
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
          <Select
            label="Status"
            options={STATUS_OPTIONS}
            value={form.watch('status')}
            onChange={(value) => form.setValue('status', value)}
          />
        </div>
        <Select
          label="Sub-category"
          options={subCategoryOptions}
          value={form.watch('subCategoryId')}
          onChange={(value) => form.setValue('subCategoryId', value)}
          error={form.formState.errors.subCategoryId?.message}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="edit-rule-expression" className="text-sm font-medium text-slate-700">
            Expression
          </label>
          <textarea
            id="edit-rule-expression"
            rows={3}
            className="rounded-control border border-slate-300 px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            {...form.register('expression')}
          />
        </div>

        <ParameterFieldsEditor fields={fields} onChange={setFields} />

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
