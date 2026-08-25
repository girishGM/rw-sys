import type { Bootstrap } from '@reward-portal/shared';

export const superAdminBootstrap: Bootstrap = {
  user: { id: 1, displayName: 'Ada SuperAdmin', role: 'super_admin', locale: 'en', timezone: null },
  scope: { countryId: null, tenantId: null, merchantId: null },
  nav: [],
  permissions: {
    access_control: ['view', 'create', 'update', 'delete'],
    country: ['view', 'create', 'update'],
    rule: ['view', 'create', 'update', 'delete'],
  },
  widgets: [],
  messages: {},
};

export const makerBootstrap: Bootstrap = {
  user: { id: 2, displayName: 'Mo Maker', role: 'maker', locale: 'en', timezone: null },
  scope: { countryId: 1, tenantId: 1, merchantId: null },
  nav: [],
  permissions: {
    campaign: ['view', 'create', 'update', 'submit'],
  },
  widgets: [],
  messages: {},
};

export function makeAxiosError(status: number): {
  isAxiosError: true;
  response: { status: number };
  message: string;
} {
  return {
    isAxiosError: true,
    response: { status },
    message: `Request failed with status code ${status}`,
  };
}

/** T-024 — a rejection carrying the `{ error: { code } }` envelope, for the branches
 * (`isPasswordChangeRequiredError`, `AUTH_ERROR_CODE`-based screen logic) that read it. */
export function makeAxiosErrorWithCode(
  status: number,
  code: string,
): {
  isAxiosError: true;
  response: { status: number; data: { error: { code: string } } };
  message: string;
} {
  return {
    isAxiosError: true,
    response: { status, data: { error: { code } } },
    message: `Request failed with status code ${status}`,
  };
}
