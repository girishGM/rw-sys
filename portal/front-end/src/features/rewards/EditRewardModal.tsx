/**
 * T-032 — `PATCH /rewards/:id`. `systemCode` is immutable and never shown as an editable field
 * here (matches `UpdateRewardDto`'s own shape — the back end does not accept it either).
 * `connectorConfig` starts empty (see `ConnectorConfigEditor.tsx`'s header) — leaving it empty
 * omits the field from the request and leaves the stored value untouched.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  REWARD_CONNECTOR_TYPES,
  REWARD_DELIVERY_MODES,
  updateRewardRequestSchema,
  type Reward,
  type UpdateRewardRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select, type SelectOption } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { ConnectorConfigEditor, type ConnectorConfigEntry } from './ConnectorConfigEditor';
import { useUpdateRewardMutation } from './api';

const STATUS_OPTIONS: SelectOption[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];
const DELIVERY_MODE_OPTIONS: SelectOption[] = REWARD_DELIVERY_MODES.map((mode) => ({
  value: mode,
  label: mode,
}));
const CONNECTOR_TYPE_OPTIONS: SelectOption[] = REWARD_CONNECTOR_TYPES.map((type) => ({
  value: type,
  label: type,
}));

interface FormValues {
  name: string;
  description: string;
  rewardType: string;
  deliveryMode: string;
  connectorType: string;
  status: string;
}

export interface EditRewardModalProps {
  open: boolean;
  onClose: () => void;
  reward: Reward;
}

export function EditRewardModal({ open, onClose, reward }: EditRewardModalProps) {
  const mutation = useUpdateRewardMutation(reward.id);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [connectorConfig, setConnectorConfig] = useState<ConnectorConfigEntry[]>([]);

  const form = useForm<FormValues>({
    defaultValues: {
      name: reward.name,
      description: reward.description ?? '',
      rewardType: reward.rewardType,
      deliveryMode: reward.deliveryMode,
      connectorType: reward.connectorType,
      status: reward.status,
    },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      name: reward.name,
      description: reward.description ?? '',
      rewardType: reward.rewardType,
      deliveryMode: reward.deliveryMode,
      connectorType: reward.connectorType,
      status: reward.status,
    });
    setConnectorConfig([]);
    // Only re-sync when the modal (re)opens for a given reward, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [open, reward.id]);

  function handleClose(): void {
    setSubmitError(null);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const config = Object.fromEntries(
      connectorConfig.filter((entry) => entry.key !== '').map((entry) => [entry.key, entry.value]),
    );

    const payload: UpdateRewardRequest = {
      name: values.name,
      description: values.description === '' ? null : values.description,
      rewardType: values.rewardType,
      deliveryMode: values.deliveryMode as UpdateRewardRequest['deliveryMode'],
      connectorType: values.connectorType as UpdateRewardRequest['connectorType'],
      connectorConfig: Object.keys(config).length > 0 ? config : undefined,
      status:
        values.status === 'active' || values.status === 'inactive' ? values.status : undefined,
    };

    const parsed = updateRewardRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'name' || field === 'rewardType' || field === 'connectorType') {
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
      title={`Edit ${reward.systemCode}`}
      description="System code is immutable."
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
        <Input label="Description" {...form.register('description')} />
        <div className="grid grid-cols-3 gap-4">
          <Input
            label="Reward type"
            error={form.formState.errors.rewardType?.message}
            {...form.register('rewardType')}
          />
          <Select
            label="Delivery mode"
            options={DELIVERY_MODE_OPTIONS}
            value={form.watch('deliveryMode')}
            onChange={(value) => form.setValue('deliveryMode', value)}
          />
          <Select
            label="Connector type"
            options={CONNECTOR_TYPE_OPTIONS}
            value={form.watch('connectorType')}
            onChange={(value) => form.setValue('connectorType', value)}
            error={form.formState.errors.connectorType?.message}
          />
        </div>

        <ConnectorConfigEditor entries={connectorConfig} onChange={setConnectorConfig} />

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
