/**
 * T-037 step 1 — the form state behind `BasicsStep`.
 *
 * Split out of the component for the reason `ruleValues.ts` gives: a module exporting both a
 * component and plain functions breaks React Fast Refresh, which this workspace treats as an
 * error at `--max-warnings=0`.
 *
 * **This file used to convert dates, and that was the bug (T-065).** `toInstant` turned the date
 * input's `2027-02-15` into `2027-02-15T23:59:59` *in the browser's offset* for the end date, so
 * the same campaign ended on the 15th in UTC and the 16th in `Asia/Kolkata`. A campaign date is a
 * calendar date; the input already produces exactly that, and the API now speaks exactly that, so
 * the correct conversion is none at all. See `campaignDate.ts`.
 */
import type { Campaign, CreateCampaignRequest } from '@reward-portal/shared';
import { toDateInputValue } from '../campaignDate';

/** The step-1 form, as strings — what `<input>` gives and takes. */
export interface BasicsValues {
  campaignCode: string;
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  maxParticipants: string;
  budgetAmount: string;
  budgetCurrency: string;
}

export function emptyBasics(): BasicsValues {
  return {
    campaignCode: '',
    name: '',
    description: '',
    startDate: '',
    endDate: '',
    maxParticipants: '',
    budgetAmount: '',
    budgetCurrency: '',
  };
}

export function basicsFrom(campaign: Campaign): BasicsValues {
  return {
    campaignCode: campaign.campaignCode,
    name: campaign.name,
    description: campaign.description ?? '',
    startDate: toDateInputValue(campaign.startDate),
    endDate: toDateInputValue(campaign.endDate),
    maxParticipants: campaign.maxParticipants === null ? '' : String(campaign.maxParticipants),
    budgetAmount: campaign.budgetAmount ?? '',
    budgetCurrency: campaign.budgetCurrency ?? '',
  };
}

/** The step-1 form as `POST /campaigns` wants it. Empty optional fields are **omitted**, never
 * sent as `''` — the shared schema's `.strict()` optionals treat absent and empty differently.
 *
 * The two dates are passed through untouched: `<input type="date">` already holds the calendar
 * date the maker picked, and the contract wants that exact string (T-065). */
export function toCreateRequest(values: BasicsValues): CreateCampaignRequest {
  return {
    campaignCode: values.campaignCode.trim(),
    name: values.name.trim(),
    ...(values.description.trim() === '' ? {} : { description: values.description.trim() }),
    startDate: values.startDate,
    endDate: values.endDate,
    ...(values.maxParticipants === '' ? {} : { maxParticipants: Number(values.maxParticipants) }),
    ...(values.budgetAmount === '' ? {} : { budgetAmount: values.budgetAmount }),
    ...(values.budgetCurrency === ''
      ? {}
      : { budgetCurrency: values.budgetCurrency.toUpperCase() }),
  };
}
