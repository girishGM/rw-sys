/**
 * T-038 implementation note 5 — the expiry sweep, and the one write in this module that has no
 * actor behind it.
 *
 * ### Why this is raw SQL rather than `ScopedRepository`
 *
 * `ScopedRepository` refuses to issue a query at all when there is no `ScopeContext`
 * (`scope-context.ts`: *"a missing scope context is a hard 500, never a silent full-table
 * query"*), and a scheduled sweep runs outside every request — there is no verified JWT, no
 * tenant, no role. That is not a gap to work around; it is the design working. A sweep is
 * inherently cross-tenant housekeeping, so there is no honest scope to run it under, and
 * inventing one (a synthetic "system" super-admin, say) would put a bypass into the one class
 * whose whole value is that it has none.
 *
 * So the sweep takes the shape `notifications.repository.ts` and `common/audit/audit.repository.ts`
 * already established for the same category of problem: a **single, narrow, parameterless**
 * statement, written out in full here where a reviewer can read exactly which rows it can touch.
 * Two properties bound it, and both are visible in the SQL rather than asserted in prose:
 *
 *  - it only ever moves `pending` → `expired`, so it can neither undo a decision nor make one;
 *  - its predicate is `expires_at <= now()`, evaluated by the database, so it cannot expire a
 *    row that is not actually past its deadline.
 *
 * **Correctness never depends on this having run.** `ApprovalsService` treats any stale row as
 * expired on every read and before every decision (`isApprovalExpired`, shared with the SPA), so
 * this class only tidies the stored value — TC-13 and TC-14 both hold with the scheduler stopped.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { APPROVAL_STATUS } from './approvals.constants';

/** What {@link ApprovalExpirySweeper} depends on. Implemented below; faked in unit tests. */
export interface ApprovalExpiryStore {
  /** Marks every timed-out `pending` request `expired`. Returns how many rows changed. */
  markExpired(): Promise<number>;
}

/** DI token — consumers depend on {@link ApprovalExpiryStore}, never on the class. */
export const APPROVAL_EXPIRY_STORE = Symbol('APPROVAL_EXPIRY_STORE');

@Injectable()
export class ApprovalsRepository implements ApprovalExpiryStore {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async markExpired(): Promise<number> {
    // `updated_at` is maintained by Sequelize elsewhere and has no database-level trigger, so a
    // raw UPDATE has to set it explicitly — otherwise a swept row would report a modification
    // time from before the sweep, which is exactly the sort of small lie that costs an hour
    // during an incident.
    const [, affected] = await this.sequelize.query(
      `
      UPDATE reward_portal.portal_approval_requests
         SET status = :expired, updated_at = now()
       WHERE status = :pending
         AND expires_at <= now()
      `,
      {
        type: QueryTypes.UPDATE,
        replacements: { expired: APPROVAL_STATUS.EXPIRED, pending: APPROVAL_STATUS.PENDING },
      },
    );
    return typeof affected === 'number' ? affected : 0;
  }
}
