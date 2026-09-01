/**
 * T-006 — mirrors `tracking-service`'s `Customer` (`data/customers.ts`), returned verbatim by
 * `GET /api/customers`.
 */
export interface Customer {
  readonly id: string;
  readonly displayName: string;
  readonly avatarInitials: string;
}
