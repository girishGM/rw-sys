/**
 * T-047 — the descriptors `proto-codec.ts` encodes and decodes against, one per message in
 * `proto/campaign_config.v1.proto`.
 *
 * **This file is a transcription, not a design.** Every field name and number here is copied from
 * the `.proto`, which is the cross-team contract; where the two disagree the `.proto` is right and
 * this file is a bug. `test/grpc/proto-contract.spec.ts` parses the `.proto` source and asserts
 * they agree field-for-field and number-for-number, so the disagreement fails the build rather
 * than surfacing as a mis-deserialised field in the transaction runtime months later.
 *
 * When `@grpc/proto-loader` becomes installable (see `proto-codec.ts`'s header), this file is
 * deleted and the loader reads the `.proto` directly. Nothing else changes.
 */
import type { MessageDescriptor } from './proto-codec';

// --- supporting structure --------------------------------------------------------------------

export const MoneyMessage: MessageDescriptor = {
  name: 'Money',
  fields: [
    { name: 'amount', no: 1, type: 'string' },
    { name: 'currency', no: 2, type: 'string' },
  ],
};

export const ActivityMessage: MessageDescriptor = {
  name: 'Activity',
  fields: [
    { name: 'activity_id', no: 1, type: 'int32' },
    { name: 'activity_code', no: 2, type: 'string' },
    { name: 'name', no: 3, type: 'string' },
    // T-171 — transcribed from the `.proto`, which is the contract. Appended at the next free
    // number; 1-3 above are untouched.
    { name: 'external_codes', no: 4, type: 'string', repeated: true },
  ],
};

export const MerchantMessage: MessageDescriptor = {
  name: 'Merchant',
  fields: [
    { name: 'merchant_id', no: 1, type: 'int32' },
    { name: 'merchant_code', no: 2, type: 'string' },
    { name: 'name', no: 3, type: 'string' },
    { name: 'status', no: 4, type: 'string' },
    { name: 'activities', no: 5, type: { message: () => ActivityMessage }, repeated: true },
  ],
};

export const TrackerComponentMessage: MessageDescriptor = {
  name: 'TrackerComponent',
  fields: [
    { name: 'component_id', no: 1, type: 'int32' },
    { name: 'component_code', no: 2, type: 'string' },
    { name: 'name', no: 3, type: 'string' },
    { name: 'activity_id', no: 4, type: 'int32' },
    { name: 'sequence_order', no: 5, type: 'int32' },
    { name: 'is_mandatory', no: 6, type: 'bool' },
    { name: 'status', no: 7, type: 'string' },
  ],
};

export const TrackerMessage: MessageDescriptor = {
  name: 'Tracker',
  fields: [
    { name: 'tracker_id', no: 1, type: 'int32' },
    { name: 'tracker_code', no: 2, type: 'string' },
    { name: 'name', no: 3, type: 'string' },
    { name: 'completion_logic', no: 4, type: 'string' },
    { name: 'completion_threshold', no: 5, type: 'int32' },
    { name: 'status', no: 6, type: 'string' },
    {
      name: 'components',
      no: 7,
      type: { message: () => TrackerComponentMessage },
      repeated: true,
    },
  ],
};

// --- the central messages ---------------------------------------------------------------------

export const BoundRuleMessage: MessageDescriptor = {
  name: 'BoundRule',
  fields: [
    { name: 'rule_id', no: 1, type: 'int32' },
    { name: 'rule_version_id', no: 2, type: 'int32' },
    { name: 'version_no', no: 3, type: 'int32' },
    { name: 'rule_code', no: 4, type: 'string' },
    { name: 'expression', no: 5, type: 'string' },
    { name: 'parameters_json', no: 6, type: 'string' },
    { name: 'bound_values_json', no: 7, type: 'string' },
    { name: 'tracker_component_id', no: 8, type: 'int32' },
    { name: 'status', no: 9, type: 'string' },
  ],
};

export const BoundRewardMessage: MessageDescriptor = {
  name: 'BoundReward',
  fields: [
    { name: 'reward_id', no: 1, type: 'int32' },
    { name: 'reward_version_id', no: 2, type: 'int32' },
    { name: 'version_no', no: 3, type: 'int32' },
    { name: 'system_code', no: 4, type: 'string' },
    { name: 'reward_type', no: 5, type: 'string' },
    { name: 'delivery_mode', no: 6, type: 'string' },
    { name: 'policies_json', no: 7, type: 'string' },
    { name: 'unit_type', no: 8, type: 'string' },
    { name: 'unit_code', no: 9, type: 'string' },
    { name: 'level', no: 10, type: 'string' },
    { name: 'ref_id', no: 11, type: 'int32' },
    { name: 'status', no: 12, type: 'string' },
  ],
};

export const CampaignCapMessage: MessageDescriptor = {
  name: 'CampaignCap',
  fields: [
    { name: 'cap_class', no: 1, type: 'string' },
    { name: 'scope_level', no: 2, type: 'string' },
    { name: 'scope_ref_id', no: 3, type: 'int32' },
    { name: 'period_type', no: 4, type: 'string' },
    { name: 'period_value', no: 5, type: 'int32' },
    { name: 'window_start_time', no: 6, type: 'string' },
    { name: 'window_end_time', no: 7, type: 'string' },
    { name: 'period_timezone', no: 8, type: 'string' },
    { name: 'unit_type', no: 9, type: 'string' },
    { name: 'unit_code', no: 10, type: 'string' },
    { name: 'reward_type', no: 11, type: 'string' },
    { name: 'max_total_amount', no: 12, type: 'string' },
    { name: 'max_occurrences', no: 13, type: 'int32' },
    { name: 'max_customers', no: 14, type: 'int32' },
    { name: 'on_breach', no: 15, type: 'string' },
    { name: 'warn_at_percent', no: 16, type: 'int32' },
  ],
};

export const CampaignConfigMessage: MessageDescriptor = {
  name: 'CampaignConfig',
  fields: [
    { name: 'campaign_id', no: 1, type: 'int32' },
    { name: 'campaign_code', no: 2, type: 'string' },
    { name: 'tenant_id', no: 3, type: 'int32' },
    { name: 'country_id', no: 4, type: 'int32' },
    { name: 'status', no: 5, type: 'string' },
    { name: 'start_date', no: 6, type: 'string' },
    { name: 'end_date', no: 7, type: 'string' },
    { name: 'budget', no: 8, type: { message: () => MoneyMessage } },
    { name: 'max_participants', no: 9, type: 'int32' },
    { name: 'merchants', no: 10, type: { message: () => MerchantMessage }, repeated: true },
    { name: 'trackers', no: 11, type: { message: () => TrackerMessage }, repeated: true },
    { name: 'rules', no: 12, type: { message: () => BoundRuleMessage }, repeated: true },
    { name: 'rewards', no: 13, type: { message: () => BoundRewardMessage }, repeated: true },
    { name: 'etag', no: 14, type: 'string' },
    { name: 'config_hash', no: 15, type: 'string' },
    { name: 'not_modified', no: 16, type: 'bool' },
    { name: 'served_at', no: 17, type: 'string' },
    { name: 'caps', no: 18, type: { message: () => CampaignCapMessage }, repeated: true },
    { name: 'sections_returned', no: 19, type: 'enum', repeated: true },
    { name: 'sections_omitted', no: 20, type: 'enum', repeated: true },
  ],
};

// --- requests and envelopes --------------------------------------------------------------------

export const GetCampaignConfigRequestMessage: MessageDescriptor = {
  name: 'GetCampaignConfigRequest',
  fields: [
    { name: 'tenant_id', no: 1, type: 'int32' },
    { name: 'campaign_code', no: 2, type: 'string' },
    { name: 'etag', no: 3, type: 'string' },
    { name: 'sections', no: 4, type: 'enum', repeated: true },
  ],
};

export const ListActiveCampaignsRequestMessage: MessageDescriptor = {
  name: 'ListActiveCampaignsRequest',
  fields: [
    { name: 'tenant_id', no: 1, type: 'int32' },
    { name: 'sections', no: 2, type: 'enum', repeated: true },
  ],
};

export const CampaignConfigListMessage: MessageDescriptor = {
  name: 'CampaignConfigList',
  fields: [
    { name: 'campaigns', no: 1, type: { message: () => CampaignConfigMessage }, repeated: true },
    { name: 'served_at', no: 2, type: 'string' },
    { name: 'sections_returned', no: 3, type: 'enum', repeated: true },
    { name: 'sections_omitted', no: 4, type: 'enum', repeated: true },
  ],
};

export const WatchRequestMessage: MessageDescriptor = {
  name: 'WatchRequest',
  fields: [{ name: 'tenant_id', no: 1, type: 'int32' }],
};

export const ConfigChangeEventMessage: MessageDescriptor = {
  name: 'ConfigChangeEvent',
  fields: [
    { name: 'campaign_id', no: 1, type: 'int32' },
    { name: 'campaign_code', no: 2, type: 'string' },
    { name: 'tenant_id', no: 3, type: 'int32' },
    { name: 'change_type', no: 4, type: 'enum' },
    { name: 'etag', no: 5, type: 'string' },
    { name: 'occurred_at', no: 6, type: 'string' },
  ],
};

export const ResolveRuleVersionRequestMessage: MessageDescriptor = {
  name: 'ResolveRuleVersionRequest',
  fields: [
    { name: 'tenant_id', no: 1, type: 'int32' },
    { name: 'rule_id', no: 2, type: 'int32' },
    { name: 'version_no', no: 3, type: 'int32' },
  ],
};

export const RuleVersionDetailMessage: MessageDescriptor = {
  name: 'RuleVersionDetail',
  fields: [
    { name: 'rule_id', no: 1, type: 'int32' },
    { name: 'rule_code', no: 2, type: 'string' },
    { name: 'name', no: 3, type: 'string' },
    { name: 'version_no', no: 4, type: 'int32' },
    { name: 'expression', no: 5, type: 'string' },
    { name: 'parameters_json', no: 6, type: 'string' },
    { name: 'status', no: 7, type: 'string' },
    { name: 'published_at', no: 8, type: 'string' },
    { name: 'change_summary', no: 9, type: 'string' },
    { name: 'exists', no: 10, type: 'bool' },
    { name: 'rule_version_id', no: 11, type: 'int32' },
  ],
};

export const ResolveRewardVersionRequestMessage: MessageDescriptor = {
  name: 'ResolveRewardVersionRequest',
  fields: [
    { name: 'tenant_id', no: 1, type: 'int32' },
    { name: 'reward_id', no: 2, type: 'int32' },
    { name: 'version_no', no: 3, type: 'int32' },
  ],
};

export const RewardVersionDetailMessage: MessageDescriptor = {
  name: 'RewardVersionDetail',
  fields: [
    { name: 'reward_id', no: 1, type: 'int32' },
    { name: 'system_code', no: 2, type: 'string' },
    { name: 'name', no: 3, type: 'string' },
    { name: 'version_no', no: 4, type: 'int32' },
    { name: 'reward_type', no: 5, type: 'string' },
    { name: 'delivery_mode', no: 6, type: 'string' },
    { name: 'policies_json', no: 7, type: 'string' },
    { name: 'unit_type', no: 8, type: 'string' },
    { name: 'unit_code', no: 9, type: 'string' },
    { name: 'status', no: 10, type: 'string' },
    { name: 'published_at', no: 11, type: 'string' },
    { name: 'change_summary', no: 12, type: 'string' },
    { name: 'exists', no: 13, type: 'bool' },
    { name: 'reward_version_id', no: 14, type: 'int32' },
  ],
};

export const BudgetStatusRequestMessage: MessageDescriptor = {
  name: 'BudgetStatusRequest',
  fields: [
    { name: 'tenant_id', no: 1, type: 'int32' },
    { name: 'campaign_code', no: 2, type: 'string' },
  ],
};

export const BudgetStatusEntryMessage: MessageDescriptor = {
  name: 'BudgetStatusEntry',
  fields: [
    { name: 'cap_id', no: 1, type: 'int32' },
    { name: 'cap_class', no: 2, type: 'string' },
    { name: 'scope_level', no: 3, type: 'string' },
    { name: 'scope_ref_id', no: 4, type: 'int32' },
    { name: 'period_type', no: 5, type: 'string' },
    { name: 'unit_type', no: 6, type: 'string' },
    { name: 'unit_code', no: 7, type: 'string' },
    { name: 'max_total_amount', no: 8, type: 'string' },
    { name: 'max_occurrences', no: 9, type: 'int32' },
    { name: 'on_breach', no: 10, type: 'string' },
    { name: 'warn_at_percent', no: 11, type: 'int32' },
  ],
};

export const BudgetStatusResponseMessage: MessageDescriptor = {
  name: 'BudgetStatusResponse',
  fields: [
    { name: 'campaign_id', no: 1, type: 'int32' },
    { name: 'served_at', no: 2, type: 'string' },
    { name: 'entries', no: 3, type: { message: () => BudgetStatusEntryMessage }, repeated: true },
  ],
};

/** Every descriptor, for the contract test. */
export const ALL_MESSAGES: readonly MessageDescriptor[] = Object.freeze([
  MoneyMessage,
  ActivityMessage,
  MerchantMessage,
  TrackerComponentMessage,
  TrackerMessage,
  BoundRuleMessage,
  BoundRewardMessage,
  CampaignCapMessage,
  CampaignConfigMessage,
  GetCampaignConfigRequestMessage,
  ListActiveCampaignsRequestMessage,
  CampaignConfigListMessage,
  WatchRequestMessage,
  ConfigChangeEventMessage,
  ResolveRuleVersionRequestMessage,
  RuleVersionDetailMessage,
  ResolveRewardVersionRequestMessage,
  RewardVersionDetailMessage,
  BudgetStatusRequestMessage,
  BudgetStatusEntryMessage,
  BudgetStatusResponseMessage,
]);
