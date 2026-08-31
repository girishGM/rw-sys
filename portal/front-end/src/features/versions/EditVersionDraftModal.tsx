/**
 * T-041 — `PATCH /rules/:id/versions/:vid` / `PATCH /rewards/:id/versions/:vid`. Draft only —
 * the server refuses (409) on any other status; this modal is only ever opened from a `draft`
 * row (`VersionsPanel`'s own guard), so hiding the control here is UX, not the enforcement.
 *
 * The payload is edited as raw JSON text for both `parameters` (rule) and `connectorConfig`
 * (reward) — the full `ParameterFieldsEditor` (`features/rules/ParameterFieldsEditor.tsx`)
 * builds the *meta*-schema for a brand-new rule; a version *edit* is a much rarer, expert
 * action (06-VERSIONING.md's whole point is that most changes are a **new version**, not an
 * edit of one already drafted), so a plain, validated JSON textarea — with the same
 * `RuleParameters`/`connectorConfig` shape the server itself validates — is the pragmatic
 * choice here rather than re-deriving that editor's full UI a second time.
 *
 * T-110 — resolver wiring (T-102/T-103/T-109) is editable here too, rule versions only
 * (implementation note 3): a Resolver `Select`, a Resolver config JSON `textarea` (same pattern
 * as the parameters/connectorConfig textarea above), an Evaluation context `Select` sourced from
 * a fixed client-side list (implementation note 1 — these five values are resolver *semantics*,
 * not registry data), and a Default operators `MultiSelect` sourced from `GET /rule-operators`
 * (T-108). Every one of the four is optional and nullable (implementation note 4) — each `Select`
 * carries an explicit "None" option (the same pattern `RulesListPage.tsx`'s
 * `ALL_CATEGORIES_OPTION` already uses) so a previously-wired draft can be cleared back to inert,
 * not just left unset.
 */
import { useEffect, useMemo, useState } from 'react';
import type { RewardVersion, RuleVersion } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal } from '../../components/Modal';
import { MultiSelect, type MultiSelectOption } from '../../components/MultiSelect';
import { Select, type SelectOption } from '../../components/Select';
import { Toggle } from '../../components/Toggle';
import { ApiError } from '../../lib/apiError';
import { useRuleOperatorsQuery, useRuleResolversQuery } from '../rules/api';
import { useUpdateDraftMutation, type VersionEntityType } from './api';

const NONE_RESOLVER_OPTION: SelectOption = {
  value: '',
  label: 'None — not wired to the rule engine',
};

/** Resolver semantics, not registry data — implementation note 1. */
const EVALUATION_CONTEXT_OPTIONS: SelectOption[] = [
  { value: '', label: 'None' },
  { value: 'transaction_payload', label: 'Transaction payload' },
  { value: 'tracker_state', label: 'Tracker state' },
  { value: 'customer_profile', label: 'Customer profile' },
  { value: 'aggregate', label: 'Aggregate' },
  { value: 'schedule', label: 'Schedule' },
];

export interface EditVersionDraftModalProps {
  open: boolean;
  onClose: () => void;
  entityType: VersionEntityType;
  entityId: number;
  version: RuleVersion | RewardVersion;
}

function isRuleVersion(
  entityType: VersionEntityType,
  _version: RuleVersion | RewardVersion,
): _version is RuleVersion {
  return entityType === 'rule';
}

export function EditVersionDraftModal({
  open,
  onClose,
  entityType,
  entityId,
  version,
}: EditVersionDraftModalProps) {
  const mutation = useUpdateDraftMutation(entityType, entityId, version.id);
  // T-110 — fetched unconditionally (same call-unconditionally-render-conditionally pattern
  // `AddRuleModal.tsx`'s own `resolversQuery` uses): the fields these back are only rendered
  // for `entityType === 'rule'`, but the two `useQuery` calls themselves can't be conditional
  // (rules of hooks) and the extra request is harmless — react-query caches it by key, so a
  // rewards-only session pays for it once, not per open.
  const resolversQuery = useRuleResolversQuery();
  const operatorsQuery = useRuleOperatorsQuery();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [changeSummary, setChangeSummary] = useState(version.changeSummary ?? '');
  const [expression, setExpression] = useState(
    isRuleVersion(entityType, version) ? (version.expression ?? '') : '',
  );
  const [payloadText, setPayloadText] = useState('{}');
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [isBreaking, setIsBreaking] = useState(version.isBreaking);
  const [confirmOverride, setConfirmOverride] = useState(false);
  const [resolverId, setResolverId] = useState('');
  const [resolverConfigText, setResolverConfigText] = useState('');
  const [resolverConfigError, setResolverConfigError] = useState<string | null>(null);
  const [evaluationContext, setEvaluationContext] = useState('');
  const [defaultOperators, setDefaultOperators] = useState<string[]>([]);

  const resolverOptions: SelectOption[] = useMemo(
    () => [
      NONE_RESOLVER_OPTION,
      ...(resolversQuery.data ?? []).map((resolver) => ({
        value: String(resolver.id),
        label: `${resolver.name} (${resolver.resolverCode})`,
      })),
    ],
    [resolversQuery.data],
  );

  const operatorOptions: MultiSelectOption[] = useMemo(
    () =>
      (operatorsQuery.data ?? []).map((operator) => ({
        value: operator.operatorCode,
        label: operator.displayName,
      })),
    [operatorsQuery.data],
  );

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    setPayloadError(null);
    setResolverConfigError(null);
    setConfirmOverride(false);
    setChangeSummary(version.changeSummary ?? '');
    setIsBreaking(version.isBreaking);
    if (isRuleVersion(entityType, version)) {
      setExpression(version.expression ?? '');
      setPayloadText(JSON.stringify(version.parameters, null, 2));
      setResolverId(version.resolverId != null ? String(version.resolverId) : '');
      setResolverConfigText(
        version.resolverConfig != null ? JSON.stringify(version.resolverConfig, null, 2) : '',
      );
      setEvaluationContext(version.evaluationContext ?? '');
      setDefaultOperators(version.defaultOperators ? [...version.defaultOperators] : []);
    } else {
      setPayloadText(JSON.stringify(version.connectorConfig, null, 2));
    }
    // Only re-sync on open/version change, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [open, version.id]);

  function handleClose(): void {
    onClose();
  }

  async function handleSubmit(): Promise<void> {
    setSubmitError(null);
    setPayloadError(null);
    setResolverConfigError(null);

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadText) as Record<string, unknown>;
    } catch {
      setPayloadError('Must be valid JSON.');
      return;
    }

    let resolverConfig: Record<string, unknown> | null = null;
    if (entityType === 'rule' && resolverConfigText.trim() !== '') {
      try {
        resolverConfig = JSON.parse(resolverConfigText) as Record<string, unknown>;
      } catch {
        setResolverConfigError('Must be valid JSON.');
        return;
      }
    }

    try {
      if (entityType === 'rule') {
        await mutation.mutateAsync({
          expression: expression === '' ? null : expression,
          parameters: payload,
          changeSummary: changeSummary === '' ? null : changeSummary,
          isBreaking,
          confirmBreakingOverride: confirmOverride || undefined,
          resolverId: resolverId === '' ? null : Number(resolverId),
          resolverConfig,
          evaluationContext: evaluationContext === '' ? null : evaluationContext,
          defaultOperators: defaultOperators.length === 0 ? null : defaultOperators,
        });
      } else {
        await mutation.mutateAsync({
          connectorConfig: payload,
          changeSummary: changeSummary === '' ? null : changeSummary,
          isBreaking,
          confirmBreakingOverride: confirmOverride || undefined,
        });
      }
      handleClose();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_BREAKING_CONFIRMATION_REQUIRED') {
        setSubmitError(
          'The system disagrees with your is_breaking choice. Review the diff, then check ' +
            '"I have reviewed this" to override.',
        );
        setConfirmOverride(true);
        return;
      }
      setSubmitError(error instanceof ApiError ? error.message : 'Could not save this draft.');
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Edit draft v${String(version.versionNo)}`}
      description="Only draft versions may be edited. Publishing freezes this row forever."
      size="lg"
    >
      <div className="flex flex-col gap-4">
        {submitError && (
          <p
            role="alert"
            className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700"
          >
            {submitError}
          </p>
        )}

        <Input
          label="Change summary"
          value={changeSummary}
          onChange={(event) => setChangeSummary(event.target.value)}
        />

        {entityType === 'rule' && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-version-expression" className="text-sm font-medium text-slate-700">
              Expression
            </label>
            <textarea
              id="edit-version-expression"
              rows={2}
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
              className="rounded-control border border-slate-300 px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
            />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="edit-version-payload" className="text-sm font-medium text-slate-700">
            {entityType === 'rule' ? 'Parameters (JSON)' : 'Connector config (JSON)'}
          </label>
          <textarea
            id="edit-version-payload"
            rows={8}
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
            className="rounded-control border border-slate-300 px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
          />
          {payloadError && (
            <p role="alert" className="text-xs text-danger-600">
              {payloadError}
            </p>
          )}
        </div>

        {entityType === 'rule' && (
          <>
            <Select
              label="Resolver"
              options={resolverOptions}
              value={resolverId}
              onChange={setResolverId}
            />

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="edit-version-resolver-config"
                className="text-sm font-medium text-slate-700"
              >
                Resolver config (JSON)
              </label>
              <textarea
                id="edit-version-resolver-config"
                rows={4}
                value={resolverConfigText}
                onChange={(event) => setResolverConfigText(event.target.value)}
                className="rounded-control border border-slate-300 px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
              />
              {resolverConfigError && (
                <p role="alert" className="text-xs text-danger-600">
                  {resolverConfigError}
                </p>
              )}
            </div>

            <Select
              label="Evaluation context"
              options={EVALUATION_CONTEXT_OPTIONS}
              value={evaluationContext}
              onChange={setEvaluationContext}
            />

            <MultiSelect
              label="Default operators"
              options={operatorOptions}
              value={defaultOperators}
              onChange={setDefaultOperators}
            />
          </>
        )}

        <Toggle
          label="Breaking change"
          checked={isBreaking}
          onChange={(checked) => {
            setIsBreaking(checked);
            setConfirmOverride(false);
          }}
        />
        {confirmOverride && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={confirmOverride}
              onChange={(event) => setConfirmOverride(event.target.checked)}
              className="size-4 rounded border-slate-300 text-primary-600"
            />
            I have reviewed the diff and confirm this is_breaking value.
          </label>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void handleSubmit();
            }}
            isLoading={mutation.isPending}
          >
            Save draft
          </Button>
        </div>
      </div>
    </Modal>
  );
}
