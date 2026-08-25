/**
 * T-032 — `POST /rewards/:id/policies` (03-API-CONTRACT.md §9, super_admin only).
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  createRewardPolicyRequestSchema,
  type CreateRewardPolicyRequest,
} from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/apiError';
import { useCreateRewardPolicyMutation } from './api';

interface FormValues {
  policyCode: string;
  name: string;
  description: string;
}

const DEFAULT_VALUES: FormValues = { policyCode: '', name: '', description: '' };

export interface AddPolicyModalProps {
  open: boolean;
  onClose: () => void;
  rewardId: number;
}

export function AddPolicyModal({ open, onClose, rewardId }: AddPolicyModalProps) {
  const mutation = useCreateRewardPolicyMutation(rewardId);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });

  function handleClose(): void {
    setSubmitError(null);
    form.reset(DEFAULT_VALUES);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const payload: CreateRewardPolicyRequest = {
      policyCode: values.policyCode,
      name: values.name,
      description: values.description === '' ? undefined : values.description,
    };

    const parsed = createRewardPolicyRequestSchema.safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'policyCode' || field === 'name') {
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
      title="Add policy"
      description="Add a reward policy to this system."
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
          label="Policy code"
          placeholder="STANDARD"
          error={form.formState.errors.policyCode?.message}
          {...form.register('policyCode')}
        />
        <Input
          label="Name"
          placeholder="Standard policy"
          error={form.formState.errors.name?.message}
          {...form.register('name')}
        />
        <Input label="Description" placeholder="Optional" {...form.register('description')} />

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={mutation.isPending}>
            Add policy
          </Button>
        </div>
      </form>
    </Modal>
  );
}
