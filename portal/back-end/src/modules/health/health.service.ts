/**
 * T-052 — the dependency check behind `GET /health/ready`.
 *
 * Deliberately the only thing this service does. `GET /health` (liveness, T-001/T-013)
 * answers "is the process up"; `/health/ready` answers "can this process actually serve a
 * request" — 03-API-CONTRACT.md §14 names the database as the one dependency worth gating
 * on. Neither response may disclose a version, a dependency name or a schema name (§14),
 * which is why {@link HealthService#isDatabaseReachable} returns a bare boolean rather than
 * the driver error: the caller decides the HTTP status, and nothing downstream of this
 * class ever sees the exception's message, code or stack.
 *
 * `sequelize.authenticate()` — not a query against any table — is the check itself: it opens
 * (or reuses, from the pool) a connection and runs the driver's own liveness ping, without
 * naming `reward_portal`, `reward_config`, or any table in either.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * `true` when the database connection is usable, `false` otherwise. Never throws — a
   * readiness probe that can itself fail with an unhandled rejection defeats the point of
   * having one, and 03-API-CONTRACT.md §14's "no dependency details" guarantee only holds if
   * the failure is caught here, not re-thrown for a filter to serialise.
   */
  async isDatabaseReachable(): Promise<boolean> {
    try {
      await this.sequelize.authenticate();
      return true;
    } catch (error) {
      // The message is logged (operators need it) but never returned to the caller — see the
      // class header. `warn`, not `error`: a database blip that self-heals within a few probe
      // intervals is exactly what `/health/ready` exists to shield callers from, not an
      // incident on its own (08-OBSERVABILITY.md §4 reserves `error` for things that need a
      // human now).
      this.logger.warn(
        `/health/ready: database not reachable — ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
