/**
 * T-037 step 1 — *"Basics: name · code · dates · budget · max participants"* (04-FRONTEND.md §5.2).
 *
 * The one step that exists in two modes: it **creates** the campaign the first time it is saved
 * (there is nothing to attach steps 2–7 to until then) and patches it afterwards. That is why the
 * wizard's route is `/campaigns/new` before the first save and `/campaigns/:id` after it.
 *
 * Validation is `createCampaignRequestSchema` / `updateCampaignRequestSchema` from
 * `packages/shared` — the same objects the server parses (TC-8/TC-9/TC-11), so the maker sees
 * "endDate must be after startDate" against the field rather than as a 400 from the API.
 */
import { useState } from 'react';
import { createCampaignRequestSchema, type Campaign } from '@reward-portal/shared';
import { Button } from '../../../components/Button';
import { Card, CardBody } from '../../../components/Card';
import { Input } from '../../../components/Input';
import { toCreateRequest, type BasicsValues } from './basicsValues';

export interface BasicsStepProps {
  readonly values: BasicsValues;
  readonly onChange: (values: BasicsValues) => void;
  readonly onSave: () => void;
  readonly saving: boolean;
  /** Absent while creating; present (and locking `campaignCode`) once saved. */
  readonly campaign: Campaign | null;
  readonly serverError?: string;
}

export function BasicsStep({
  values,
  onChange,
  onSave,
  saving,
  campaign,
  serverError,
}: BasicsStepProps) {
  const [touched, setTouched] = useState(false);
  const errors = touched ? validate(values) : {};

  function set<K extends keyof BasicsValues>(key: K, value: BasicsValues[K]): void {
    onChange({ ...values, [key]: value });
  }

  return (
    <Card>
      <CardBody className="grid gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Input
            label="Campaign code"
            hint={
              campaign === null
                ? 'Unique within your tenant. Cannot be changed later.'
                : 'Fixed once the campaign exists.'
            }
            error={errors.campaignCode}
            value={values.campaignCode}
            disabled={campaign !== null}
            onChange={(event) => {
              set('campaignCode', event.target.value);
            }}
          />
          <Input
            label="Campaign name"
            error={errors.name}
            value={values.name}
            onChange={(event) => {
              set('name', event.target.value);
            }}
          />
        </div>

        <Input
          label="Description"
          value={values.description}
          onChange={(event) => {
            set('description', event.target.value);
          }}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <Input
            type="date"
            label="Start date"
            hint="Interpreted in your own timezone."
            error={errors.startDate}
            value={values.startDate}
            onChange={(event) => {
              set('startDate', event.target.value);
            }}
          />
          <Input
            type="date"
            label="End date"
            error={errors.endDate}
            value={values.endDate}
            onChange={(event) => {
              set('endDate', event.target.value);
            }}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          <Input
            type="number"
            min={1}
            label="Max participants"
            hint="Optional."
            value={values.maxParticipants}
            onChange={(event) => {
              set('maxParticipants', event.target.value);
            }}
          />
          <Input
            label="Budget amount"
            hint="Optional here — step 6 is where budgets are really set."
            error={errors.budgetAmount}
            value={values.budgetAmount}
            onChange={(event) => {
              set('budgetAmount', event.target.value);
            }}
          />
          <Input
            label="Currency"
            hint="Three letters, e.g. MYR."
            error={errors.budgetCurrency}
            value={values.budgetCurrency}
            onChange={(event) => {
              set('budgetCurrency', event.target.value.toUpperCase());
            }}
          />
        </div>

        {serverError !== undefined && (
          <p role="alert" className="text-sm text-rose-600">
            {serverError}
          </p>
        )}

        <div>
          <Button
            type="button"
            isLoading={saving}
            onClick={() => {
              setTouched(true);
              if (Object.keys(validate(values)).length === 0) onSave();
            }}
          >
            {campaign === null ? 'Create draft' : 'Save'}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/** Runs the **shared** create schema and maps its issues onto fields. Not a second contract —
 * see this file's header. */
function validate(values: BasicsValues): Partial<Record<keyof BasicsValues, string>> {
  const errors: Partial<Record<keyof BasicsValues, string>> = {};
  if (values.campaignCode.trim() === '') errors.campaignCode = 'Required';
  if (values.name.trim() === '') errors.name = 'Required';
  if (values.startDate === '') errors.startDate = 'Required';
  if (values.endDate === '') errors.endDate = 'Required';
  if (Object.keys(errors).length > 0) return errors;

  const result = createCampaignRequestSchema.safeParse(toCreateRequest(values));
  if (result.success) return errors;

  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && errors[key as keyof BasicsValues] === undefined) {
      errors[key as keyof BasicsValues] = issue.message;
    }
  }
  return errors;
}
