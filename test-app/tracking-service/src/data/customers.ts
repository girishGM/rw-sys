/**
 * T-003 — the fixed roster of 3 demo customers (ARCHITECTURE.md §3: "no customer entity exists
 * anywhere in `reward_config`/`reward_portal` — this is necessarily new modeling").
 *
 * `Priya Shah` is the one name the task file/ARCHITECTURE.md name explicitly, for continuity with
 * the approved mockup. The mockup's own source file (a Claude Design canvas `.dc.html`) is not
 * present anywhere in this repository (confirmed by search — see the T-003 completion report's
 * "Deviations from spec"), so the other two names/initials below are this task's own reasonable
 * choice, not copied from a document this task could not find.
 */
export interface Customer {
  readonly id: string;
  readonly displayName: string;
  readonly avatarInitials: string;
}

export const CUSTOMERS: readonly Customer[] = [
  { id: 'priya-shah', displayName: 'Priya Shah', avatarInitials: 'PS' },
  { id: 'marcus-tan', displayName: 'Marcus Tan', avatarInitials: 'MT' },
  { id: 'aisha-rahman', displayName: 'Aisha Rahman', avatarInitials: 'AR' },
] as const;

const CUSTOMERS_BY_ID = new Map(CUSTOMERS.map((customer) => [customer.id, customer]));

export function getCustomerById(id: string): Customer | undefined {
  return CUSTOMERS_BY_ID.get(id);
}

export function isValidCustomerId(id: string): boolean {
  return CUSTOMERS_BY_ID.has(id);
}
