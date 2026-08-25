/**
 * T-042 — `POST /definition-requests` (06-VERSIONING.md §9/§10: "Definition requests | all
 * (raise), super_admin (triage) | The request queue").
 *
 * Validated with the exact schema the back end validates with
 * (`createDefinitionRequestSchema`, `packages/shared/src/definition-request.schema.ts`) — one
 * Zod schema, both sides, per 00-ARCHITECTURE.md §8. `entityId` is only rendered when the
 * request type is `update_rule`/`update_reward` — the service rejects the mismatched
 * combination either way (implementation note in `DefinitionRequestsService`), but hiding the
 * field for `new_*` types is the same "the guard is real either way, hiding is just UX" split
 * `RulesListPage.tsx`'s own header documents for its "Add rule" button.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  createDefinitionRequestSchema,
  DEFINITION_REQUEST_PRIORITIES,
  type CreateDefinitionRequestRequest,
  type DefinitionRequestPriority,
  type DefinitionRequestType,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { DatePicker } from '../../components/DatePicker';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select, type SelectOption } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { useCreateDefinitionRequestMutation } from './api';

const REQUEST_TYPE_OPTIONS: SelectOption[] = [
  { value: 'new_rule', label: 'New rule' },
  { value: 'update_rule', label: 'Change an existing rule' },
  { value: 'new_reward', label: 'New reward' },
  { value: 'update_reward', label: 'Change an existing reward' },
];

const PRIORITY_OPTIONS: SelectOption[] = DEFINITION_REQUEST_PRIORITIES.map((priority) => ({
  value: priority,
  label: priority[0].toUpperCase() + priority.slice(1),
}));

interface FormValues {
  requestType: DefinitionRequestType;
  entityId: string;
  title: string;
  description: string;
  businessJustification: string;
  priority: DefinitionRequestPriority;
}

const DEFAULT_VALUES: FormValues = {
  requestType: 'new_rule',
  entityId: '',
  title: '',
  description: '',
  businessJustification: '',
  priority: 'normal',
};

export interface SubmitDefinitionRequestModalProps {
  open: boolean;
  onClose: () => void;
}

export function SubmitDefinitionRequestModal({ open, onClose }: SubmitDefinitionRequestModalProps) {
  const mutation = useCreateDefinitionRequestMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [desiredBy, setDesiredBy] = useState<Date | null>(null);

  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });
  const requestType = form.watch('requestType');
  const requiresEntityId = requestType === 'update_rule' || requestType === 'update_reward';

  function handleClose(): void {
    setSubmitError(null);
    setDesiredBy(null);
    form.reset(DEFAULT_VALUES);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const payload: CreateDefinitionRequestRequest = {
      requestType: values.requestType,
      entityId: requiresEntityId && values.entityId !== '' ? Number(values.entityId) : undefined,
      title: values.title,
      description: values.description,
      businessJustification:
        values.businessJustification === '' ? undefined : values.businessJustification,
      desiredBy: desiredBy === null ? undefined : desiredBy.toISOString().slice(0, 10),
      priority: values.priority,
    };

    const parsed = createDefinitionRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'title' || field === 'description' || field === 'entityId') {
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
      title="Ask Super Admin for a rule or reward"
      description="Describe what you need — Super Admin triages every request and links back the version that fulfils it."
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
            label="Request type"
            options={REQUEST_TYPE_OPTIONS}
            value={requestType}
            onChange={(value) => form.setValue('requestType', value as DefinitionRequestType)}
          />
          <Select
            label="Priority"
            options={PRIORITY_OPTIONS}
            value={form.watch('priority')}
            onChange={(value) => form.setValue('priority', value as DefinitionRequestPriority)}
          />
        </div>

        {requiresEntityId && (
          <Input
            label="Existing rule/reward id"
            placeholder="e.g. 42"
            error={form.formState.errors.entityId?.message}
            {...form.register('entityId')}
          />
        )}

        <Input
          label="Title"
          placeholder="Weekend transaction multiplier"
          error={form.formState.errors.title?.message}
          {...form.register('title')}
        />

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="definition-request-description"
            className="text-sm font-medium text-slate-700"
          >
            Description
          </label>
          <textarea
            id="definition-request-description"
            rows={4}
            className="rounded-control border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            placeholder="What business need does this address, and what should the rule/reward do?"
            {...form.register('description')}
          />
          {form.formState.errors.description && (
            <p className="text-xs text-danger-600">{form.formState.errors.description.message}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="definition-request-justification"
            className="text-sm font-medium text-slate-700"
          >
            Business justification (optional)
          </label>
          <textarea
            id="definition-request-justification"
            rows={2}
            className="rounded-control border border-slate-300 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            {...form.register('businessJustification')}
          />
        </div>

        <DatePicker label="Desired by (optional)" value={desiredBy} onChange={setDesiredBy} />

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={mutation.isPending}>
            Submit request
          </Button>
        </div>
      </form>
    </Modal>
  );
}
