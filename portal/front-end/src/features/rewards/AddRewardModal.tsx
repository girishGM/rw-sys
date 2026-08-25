/**
 * T-032 — `POST /rewards` (04-FRONTEND.md §4: "Reward system + connector config + policies").
 *
 * Validated with the exact schema the back end validates with (`createRewardRequestSchema`,
 * `packages/shared/src/reward.schema.ts`) — one Zod schema, both sides, per 00-ARCHITECTURE.md
 * §8. `connectorConfig` is entered as key/value pairs, never rendered back once saved (the
 * server encrypts it and only ever returns a masked form — implementation note 4): this form is
 * write-only for that field, by design.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  REWARD_CONNECTOR_TYPES,
  REWARD_DELIVERY_MODES,
  createRewardRequestSchema,
  type CreateRewardRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { Select, type SelectOption } from '../../components/Select';
import { ApiError } from '../../lib/apiError';
import { ConnectorConfigEditor, type ConnectorConfigEntry } from './ConnectorConfigEditor';
import { useCreateRewardMutation } from './api';

interface FormValues {
  systemCode: string;
  name: string;
  description: string;
  rewardType: string;
  deliveryMode: string;
  connectorType: string;
}

const DEFAULT_VALUES: FormValues = {
  systemCode: '',
  name: '',
  description: '',
  rewardType: '',
  deliveryMode: 'realtime',
  connectorType: '',
};

const DELIVERY_MODE_OPTIONS: SelectOption[] = REWARD_DELIVERY_MODES.map((mode) => ({
  value: mode,
  label: mode,
}));
const CONNECTOR_TYPE_OPTIONS: SelectOption[] = REWARD_CONNECTOR_TYPES.map((type) => ({
  value: type,
  label: type,
}));

export interface AddRewardModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddRewardModal({ open, onClose }: AddRewardModalProps) {
  const mutation = useCreateRewardMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [connectorConfig, setConnectorConfig] = useState<ConnectorConfigEntry[]>([]);

  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });

  function handleClose(): void {
    setSubmitError(null);
    setConnectorConfig([]);
    form.reset(DEFAULT_VALUES);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const config = Object.fromEntries(
      connectorConfig.filter((entry) => entry.key !== '').map((entry) => [entry.key, entry.value]),
    );

    const payload: CreateRewardRequest = {
      systemCode: values.systemCode,
      name: values.name,
      description: values.description === '' ? undefined : values.description,
      rewardType: values.rewardType,
      deliveryMode:
        values.deliveryMode === ''
          ? undefined
          : (values.deliveryMode as CreateRewardRequest['deliveryMode']),
      connectorType: values.connectorType as CreateRewardRequest['connectorType'],
      connectorConfig: Object.keys(config).length > 0 ? config : undefined,
    };

    const parsed = createRewardRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (
          field === 'systemCode' ||
          field === 'name' ||
          field === 'rewardType' ||
          field === 'connectorType' ||
          field === 'deliveryMode'
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
      title="Add reward"
      description="Author a new global reward system."
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
            label="System code"
            placeholder="CASHBACK_STANDARD"
            error={form.formState.errors.systemCode?.message}
            {...form.register('systemCode')}
          />
          <Input
            label="Name"
            placeholder="Standard cashback"
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
        </div>
        <Input
          label="Description"
          placeholder="Optional"
          error={form.formState.errors.description?.message}
          {...form.register('description')}
        />
        <div className="grid grid-cols-3 gap-4">
          <Input
            label="Reward type"
            placeholder="monetary"
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
            value={form.watch('connectorType') === '' ? null : form.watch('connectorType')}
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
            Create reward
          </Button>
        </div>
      </form>
    </Modal>
  );
}
