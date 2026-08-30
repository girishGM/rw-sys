/**
 * T-032 — `POST /rewards` (04-FRONTEND.md §4: "Reward system + connector config + policies").
 *
 * Validated with the exact schema the back end validates with (`createRewardRequestSchema`,
 * `packages/shared/src/reward.schema.ts`) — one Zod schema, both sides, per 00-ARCHITECTURE.md
 * §8. `connectorConfig` is entered as key/value pairs, never rendered back once saved (the
 * server encrypts it and only ever returns a masked form — implementation note 4): this form is
 * write-only for that field, by design.
 *
 * T-120 — additive: a category/sub-category picker (T-118 made `categoryId` required on
 * `POST /rewards`) and a Kind + value editor. Every T-032 field above is untouched
 * (13-REWARD-MASTER-VALUE-SOURCES.md §1: the connector fields are "not replaced").
 *
 * **Why creating a reward with a Kind is two calls.** The Kind and its value live on
 * `reward_versions`, not on `reward_systems` (§5) — so a reward whose Kind is chosen here is
 * `POST /rewards` followed by `POST /rewards/:id/versions` carrying the pair, which is exactly
 * what `createRewardVersionRequestSchema`'s own note describes as "how the Reward Master screen
 * (T-120) authors one in a single step". The two calls cannot be one transaction from the client,
 * so the second one failing is reported as what it is — the reward exists, its Kind does not —
 * rather than by re-submitting the first (which would 409 on the duplicate system code) or by
 * closing silently as if everything had saved.
 */
import { useMemo, useState } from 'react';
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
import { RewardValueEditor } from './RewardValueEditor';
import { useCreateRewardMutation } from './api';
import {
  EMPTY_REWARD_VALUE_DRAFT,
  buildValueConfig,
  createRewardVersionDraft,
  useRewardCategoriesQuery,
  useRewardSubCategoriesQuery,
  type RewardValueDraft,
} from './rewardValue';

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
const NO_SUB_CATEGORY_OPTION: SelectOption = { value: '', label: 'None' };

export interface AddRewardModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddRewardModal({ open, onClose }: AddRewardModalProps) {
  const mutation = useCreateRewardMutation();
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [connectorConfig, setConnectorConfig] = useState<ConnectorConfigEntry[]>([]);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [subCategoryId, setSubCategoryId] = useState<number | null>(null);
  const [categoryError, setCategoryError] = useState<string | undefined>(undefined);
  const [valueDraft, setValueDraft] = useState<RewardValueDraft>(EMPTY_REWARD_VALUE_DRAFT);
  const [valueError, setValueError] = useState<string | undefined>(undefined);
  /** Set only when the reward itself was created but its Kind draft was not — see the file
   * banner. The form is past the point where re-submitting is meaningful. */
  const [partialWarning, setPartialWarning] = useState<string | null>(null);
  const [savingKind, setSavingKind] = useState(false);

  const form = useForm<FormValues>({ defaultValues: DEFAULT_VALUES });

  const categoriesQuery = useRewardCategoriesQuery();
  const subCategoriesQuery = useRewardSubCategoriesQuery(categoryId ?? undefined);

  const categoryOptions: SelectOption[] = useMemo(
    () =>
      (categoriesQuery.data ?? []).map((category) => ({
        value: String(category.id),
        label: category.name,
      })),
    [categoriesQuery.data],
  );

  // A reward category may legitimately have zero sub-categories (T-116's "Points never needs
  // one"), so "None" is always a valid choice, not a placeholder.
  const subCategoryOptions: SelectOption[] = useMemo(
    () => [
      NO_SUB_CATEGORY_OPTION,
      ...(subCategoriesQuery.data ?? []).map((subCategory) => ({
        value: String(subCategory.id),
        label: subCategory.name,
      })),
    ],
    [subCategoriesQuery.data],
  );

  function resetState(): void {
    setSubmitError(null);
    setConnectorConfig([]);
    setCategoryId(null);
    setSubCategoryId(null);
    setCategoryError(undefined);
    setValueDraft(EMPTY_REWARD_VALUE_DRAFT);
    setValueError(undefined);
    setPartialWarning(null);
    form.reset(DEFAULT_VALUES);
  }

  function handleClose(): void {
    resetState();
    onClose();
  }

  /** Picking a category always clears the sub-category — the previous one may not belong to the
   * new category (the same cascade `RulesListPage`/`AddRuleModal` use). */
  function handleCategoryChange(value: string): void {
    setCategoryId(value === '' ? null : Number(value));
    setSubCategoryId(null);
    setCategoryError(undefined);
  }

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);
    setPartialWarning(null);

    // TC-9 — a reward with no category cannot exist (`reward_systems.category_id` is NOT NULL),
    // so the request never fires without one.
    if (categoryId === null) {
      setCategoryError('Pick a category.');
      return;
    }

    const value = buildValueConfig(valueDraft);
    if (value.state === 'invalid') {
      setValueError(value.message);
      return;
    }
    setValueError(undefined);

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
      categoryId,
      subCategoryId: subCategoryId ?? undefined,
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
        if (field === 'categoryId' || field === 'subCategoryId') {
          setCategoryError(issue.message);
        }
      }
      return;
    }

    let created;
    try {
      created = await mutation.mutateAsync(parsed.data);
    } catch (error) {
      setSubmitError(toApiErrorOrUnknown(error));
      return;
    }

    if (value.state === 'ok') {
      setSavingKind(true);
      try {
        await createRewardVersionDraft(created.id, {
          rewardKind: value.rewardKind,
          valueConfig: value.valueConfig,
        });
      } catch (error) {
        // The reward is real and saved; only its Kind draft is not. Say so precisely — this is
        // not a state the user can fix by pressing "Create reward" again.
        setPartialWarning(
          `${created.systemCode} was created, but its Kind could not be saved: ${
            toApiErrorOrUnknown(error).message
          } Set it from the reward's Versions tab.`,
        );
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
      title="Add reward"
      description="Author a new global reward system."
    >
      {partialWarning !== null ? (
        <div className="flex flex-col gap-4">
          <p
            role="alert"
            className="rounded-control bg-warning-50 px-3 py-2 text-sm text-warning-700"
          >
            {partialWarning}
          </p>
          <div className="flex justify-end">
            <Button type="button" onClick={handleClose}>
              Close
            </Button>
          </div>
        </div>
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
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Category"
              options={categoryOptions}
              value={categoryId === null ? null : String(categoryId)}
              onChange={handleCategoryChange}
              error={categoryError}
            />
            <Select
              label="Sub-category"
              options={subCategoryOptions}
              value={subCategoryId === null ? '' : String(subCategoryId)}
              onChange={(value) => setSubCategoryId(value === '' ? null : Number(value))}
              disabled={categoryId === null}
            />
          </div>
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

          <RewardValueEditor draft={valueDraft} onChange={setValueDraft} error={valueError} />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" isLoading={mutation.isPending || savingKind}>
              Create reward
            </Button>
          </div>
        </form>
      )}
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
