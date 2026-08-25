/**
 * T-052 — `db_pool_utilisation` (08-OBSERVABILITY.md §8), sampled at scrape time rather than
 * pushed on every acquire/release.
 *
 * Sequelize (v6, `sequelize-pool`) does not publish a documented, versioned "pool stats" API —
 * `sequelize.connectionManager.pool` is the real object (`Pool` from the `sequelize-pool`
 * package, confirmed against the installed version's own `.d.ts`), but it is an internal Sequelize
 * has never promised to keep stable. Reading it defensively — every property behind a runtime
 * `typeof` guard, nothing thrown if the shape ever changes — means a future Sequelize upgrade
 * that moves this can degrade this one gauge to "unavailable" instead of crashing the metrics
 * endpoint the rest of `/metrics` still depends on.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';

export interface PoolSnapshot {
  readonly using: number;
  readonly available: number;
  readonly waiting: number;
  readonly maxSize: number;
  /** `using / maxSize`, clamped to `[0, 1]`. `null` when the pool shape could not be read. */
  readonly utilisation: number | null;
}

interface RawPool {
  readonly using?: unknown;
  readonly available?: unknown;
  readonly waiting?: unknown;
  readonly maxSize?: unknown;
}

@Injectable()
export class DbPoolSampler {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  sample(): PoolSnapshot | null {
    // `sequelize.connectionManager.pool` is an internal Sequelize object with no exported type
    // (see the class header) — every field read below is guarded with `typeof`, so an
    // unexpected shape yields `null`, never a thrown error or a fabricated number.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- T-052, reason above
    const pool = (this.sequelize as any)?.connectionManager?.pool as RawPool | undefined;
    if (pool === undefined || pool === null) return null;

    const using = numberOrNull(pool.using);
    const available = numberOrNull(pool.available);
    const waiting = numberOrNull(pool.waiting);
    const maxSize = numberOrNull(pool.maxSize);
    if (using === null || available === null || waiting === null || maxSize === null) {
      return null;
    }

    return {
      using,
      available,
      waiting,
      maxSize,
      utilisation: maxSize > 0 ? Math.min(1, Math.max(0, using / maxSize)) : null,
    };
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
