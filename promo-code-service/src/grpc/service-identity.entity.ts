/**
 * T-PC-031. Domain shape for `promo_code.grpc_service_identity` (migration `008`, added by
 * T-PC-044 against this task's own reproduced defect — see that migration's header). One row per
 * allowed client-certificate SAN, checked by `MtlsGuard` on every gRPC connection attempt
 * (`03-GRPC-CONTRACT.md` §3). Structurally independent of the portal's own
 * `reward_portal.grpc_service_grants` — no shared shape, no shared migration history
 * (AGENT-PROTOCOL.md R0/`03-GRPC-CONTRACT.md` §3).
 */

export type ServiceIdentityStatus = 'ACTIVE' | 'REVOKED';

/** Raw `promo_code.grpc_service_identity` row shape, snake_case, exactly as Postgres returns it. */
export interface ServiceIdentityRow {
  id: string;
  service_identity: string;
  description: string | null;
  status: ServiceIdentityStatus;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

/** Domain shape — camelCase, the only shape any layer above the repository ever sees. */
export interface ServiceIdentity {
  id: string;
  serviceIdentity: string;
  description: string | null;
  status: ServiceIdentityStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toDomain(row: ServiceIdentityRow): ServiceIdentity {
  return {
    id: row.id,
    serviceIdentity: row.service_identity,
    description: row.description,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
