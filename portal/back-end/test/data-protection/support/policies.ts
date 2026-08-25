/**
 * T-017 — shared fixtures for the data-protection unit suites.
 *
 * One place to build a policy row, so a spec asserting a *treatment* does not have to restate
 * thirteen columns to do it, and so a column added to `DataProtectionPolicy` breaks one file
 * rather than nine.
 */
import { DEFAULT_DATA_PROTECTION_CONFIG } from '@/common/data-protection/data-protection.config';
import type { DataProtectionConfig } from '@/common/data-protection/data-protection.config';
import { PolicySet, type DataProtectionPolicy } from '@/common/data-protection/policy.service';

/** A minimal, valid row. Override anything. */
export function policy(
  over: Partial<DataProtectionPolicy> & { policyKey: string },
): DataProtectionPolicy {
  return {
    scope: 'column',
    classification: 'internal',
    atRest: 'none',
    blindIndex: false,
    inTransit: 'tls_only',
    logTreatment: 'plain',
    maskStrategy: null,
    uiVisibility: 'plain',
    revealRoles: null,
    keyPurpose: null,
    enabled: true,
    note: null,
    ...over,
  };
}

/** `DEFAULT_DATA_PROTECTION_CONFIG` with a deep override of one or two sub-objects. */
export function config(
  over: {
    enabled?: boolean;
    failClosed?: boolean;
    logging?: Partial<DataProtectionConfig['logging']>;
    response?: Partial<DataProtectionConfig['response']>;
    reveal?: Partial<DataProtectionConfig['reveal']>;
    cache?: Partial<DataProtectionConfig['cache']>;
    atRest?: Partial<DataProtectionConfig['atRest']>;
  } = {},
): DataProtectionConfig {
  const base = DEFAULT_DATA_PROTECTION_CONFIG;
  return {
    ...base,
    enabled: over.enabled ?? base.enabled,
    failClosed: over.failClosed ?? base.failClosed,
    logging: { ...base.logging, ...over.logging },
    response: { ...base.response, ...over.response },
    reveal: { ...base.reveal, ...over.reveal },
    cache: { ...base.cache, ...over.cache },
    atRest: { ...base.atRest, ...over.atRest },
  };
}

/** A `PolicySet` over the given rows and (optionally) a non-default config. */
export function policySet(
  rows: readonly DataProtectionPolicy[],
  configuration: DataProtectionConfig = config(),
): PolicySet {
  return new PolicySet(rows, configuration);
}

/**
 * The rows the specs share: one `pii` column with a mask, one `secret` column that is omitted,
 * one `reveal_on_demand` column, one DTO secret and one plain field.
 *
 * `reward_portal.portal_users` ends up classified `secret` (the maximum over its rows), which is
 * what makes TC-12 assertable: `preferred_locale` has no row and must still be treated as secret.
 */
export const FIXTURE_POLICIES: readonly DataProtectionPolicy[] = [
  policy({
    policyKey: 'reward_portal.portal_users.email',
    classification: 'pii',
    logTreatment: 'mask',
    maskStrategy: 'email',
    uiVisibility: 'plain',
  }),
  policy({
    policyKey: 'reward_portal.portal_users.mfa_secret_enc',
    classification: 'secret',
    atRest: 'aes_256_gcm',
    keyPurpose: 'field',
    logTreatment: 'omit',
    uiVisibility: 'never',
  }),
  policy({
    policyKey: 'reward_config.merchants.contact_email',
    classification: 'pii',
    logTreatment: 'mask',
    maskStrategy: 'email',
    uiVisibility: 'reveal_on_demand',
    revealRoles: ['super_admin', 'tenant_admin'],
  }),
  policy({
    policyKey: 'dto.LoginRequest.password',
    scope: 'dto_field',
    classification: 'secret',
    logTreatment: 'omit',
    uiVisibility: 'never',
  }),
  policy({
    policyKey: 'reward_config.countries.code',
    classification: 'public',
    logTreatment: 'plain',
    uiVisibility: 'plain',
  }),
];
