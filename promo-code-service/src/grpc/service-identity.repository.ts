/**
 * T-PC-031. Scoped repository for `promo_code.grpc_service_identity`. `MtlsGuard`'s only
 * dependency on the database — a single, narrow lookup ("is any of this peer certificate's SAN
 * entries an ACTIVE allowlisted identity"), never a general CRUD surface (there is no admin API
 * for this table in this task's scope — provisioning a new allowed identity is an out-of-band
 * operation, same posture the migration's own header describes for `created_by`).
 *
 * Reuses `PROMO_CODE_SEQUELIZE` (T-PC-010's connection pool, exported by `PromoCodeConfigModule`)
 * rather than opening a second Postgres connection — same convention every other module in this
 * schema already follows.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { PROMO_CODE_SEQUELIZE } from '../modules/promo-code-config/promo-code-config.constants';

@Injectable()
export class ServiceIdentityRepository {
  constructor(@Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * `identities` is every SAN candidate extracted from the peer certificate (there can be more
   * than one `DNS:` entry) — returns the first one that is an ACTIVE allowlist row, or `null` if
   * none match (including when `identities` is empty, e.g. a certificate with no SAN at all).
   * `ix_gsi_identity_status` (migration `008`) covers this exact `(service_identity, status)`
   * lookup.
   */
  async findFirstActiveMatch(identities: readonly string[]): Promise<string | null> {
    if (identities.length === 0) {
      return null;
    }
    const rows = await this.sequelize.query<{ service_identity: string }>(
      `SELECT service_identity FROM promo_code.grpc_service_identity
         WHERE service_identity IN (:identities) AND status = 'ACTIVE'
         LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { identities: [...identities] },
      },
    );
    return rows[0]?.service_identity ?? null;
  }
}
