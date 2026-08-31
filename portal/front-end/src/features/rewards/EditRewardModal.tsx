/**
 * T-032 — `PATCH /rewards/:id`. `systemCode` is immutable and never shown as an editable field
 * here (matches `UpdateRewardDto`'s own shape — the back end does not accept it either).
 * `connectorConfig` starts empty (see `ConnectorConfigEditor.tsx`'s header) — leaving it empty
 * omits the field from the request and leaves the stored value untouched.
 *
 * T-120 — additive, on top of every field above:
 *
 * - **Category/sub-category are shown, not edited.** `updateRewardRequestSchema` has no
 *   `categoryId`/`subCategoryId` key by T-118's own decision ("changing a reward's category is a
 *   new reward, not an edit to an existing one"), so this modal displays them read-only rather
 *   than offering a picker the server would reject.
 * - **Kind/value edit the reward's draft version, not the reward row.** `reward_kind`/
 *   `value_config` live on `reward_versions` (13-REWARD-MASTER-VALUE-SOURCES.md §5). If the
 *   reward already has a `draft` version, the pair is PATCHed onto it (reusing
 *   `features/versions/api.ts#updateDraft`, which parses reward drafts with
 *   `updateRewardVersionRequestSchema` — the one that carries the pair); if it has none, a new
 *   draft is created carrying it. Published versions are frozen server-side and are never
 *   written to from here.
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
import { updateDraft, useVersionsQuery } from '../versions/api';
import { ConnectorConfigEditor, type ConnectorConfigEntry } from './ConnectorConfigEditor';
import { RewardValueEditor } from './RewardValueEditor';
import { useUpdateRewardMutation } from './api';
import {
  EMPTY_REWARD_VALUE_DRAFT,
  buildValueConfig,
  createRewardVersionDraft,
  draftFromVersion,
  type RewardValueDraft,
} from './rewardValue';

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
  const [valueDraft, setValueDraft] = useState<RewardValueDraft>(EMPTY_REWARD_VALUE_DRAFT);
  const [valueError, setValueError] = useState<string | undefined>(undefined);
  const [savingKind, setSavingKind] = useState(false);

  // The reward's own draft version, if it has one — the only version this modal may write to.
  const versionsQuery = useVersionsQuery('reward', reward.id);
  const draftVersion = (versionsQuery.data ?? []).find((version) => version.status === 'draft');

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
    setValueError(undefined);
    // Only re-sync when the modal (re)opens for a given reward, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [open, reward.id]);

  // Separate from the reset above because the draft version arrives asynchronously: the modal can
  // open before `GET /rewards/:id/versions` resolves, and the Kind editor must then fill in with
  // what is actually stored rather than stay blank (and silently clear it on the next save).
  useEffect(() => {
    if (!open) return;
    // `'rewardKind' in …` narrows `AnyVersion` to the reward half of the union — this panel is
    // always mounted with `entityType: 'reward'`, but the shared hook's type does not know that.
    setValueDraft(
      draftVersion !== undefined && 'rewardKind' in draftVersion
        ? draftFromVersion(draftVersion)
        : EMPTY_REWARD_VALUE_DRAFT,
    );
    // Keyed on the draft version's identity, not on the object itself: a refetch that returns an
    // equal-but-new object must not wipe out what the author has typed since the modal opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- T-120, see the comment above
  }, [open, reward.id, draftVersion?.id]);

  function handleClose(): void {
    setSubmitError(null);
    onClose();
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);

    const value = buildValueConfig(valueDraft);
    if (value.state === 'invalid') {
      setValueError(value.message);
      return;
    }
    setValueError(undefined);

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
    } catch (error) {
      setSubmitError(toApiErrorOrUnknown(error));
      return;
    }

    // The Kind is a second, separate write (see the file banner) — and only when one was actually
    // chosen: `unset` leaves whatever the version already holds alone rather than clearing it.
    if (value.state === 'ok') {
      setSavingKind(true);
      try {
        if (draftVersion === undefined) {
          await createRewardVersionDraft(reward.id, {
            rewardKind: value.rewardKind,
            valueConfig: value.valueConfig,
          });
        } else {
          await updateDraft('reward', reward.id, draftVersion.id, {
            rewardKind: value.rewardKind,
            valueConfig: value.valueConfig,
          });
        }
      } catch (error) {
        setSubmitError(toApiErrorOrUnknown(error));
        return;
      } finally {
        setSavingKind(false);
      }
    }

    handleClose();
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

        {/* Read-only: T-118 made category/sub-category immutable-by-replacement — see the file
            banner. Shown anyway because "which category is this reward in?" is the first thing
            this screen is asked. */}
        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-slate-500">Category</dt>
          <dd className="text-slate-900">{reward.categoryName}</dd>
          <dt className="text-slate-500">Sub-category</dt>
          <dd className="text-slate-900">{reward.subCategoryName ?? '—'}</dd>
        </dl>

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

        <RewardValueEditor draft={valueDraft} onChange={setValueDraft} error={valueError} />
        {draftVersion === undefined && valueDraft.kind !== '' && (
          <p className="text-xs text-slate-500">
            This reward has no draft version — saving creates one carrying this Kind. Published
            versions are never modified.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={mutation.isPending || savingKind}>
            Save changes
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Every failure this form shows the user is an `ApiError`; anything else becomes the same
 * deliberately generic message T-032 already used. */
function toApiErrorOrUnknown(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError({
        code: 'UNKNOWN_ERROR',
        message: 'Something went wrong. Please try again.',
        status: 0,
      });
}
