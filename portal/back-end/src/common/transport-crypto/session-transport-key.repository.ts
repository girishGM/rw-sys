/**
 * T-018 — the only door to `reward_portal.portal_sessions.transport_key_enc`.
 *
 * ### Why raw SQL rather than `ScopedRepository` (AGENT-PROTOCOL R2)
 *
 * Exactly the argument `session.repository.ts` makes for the rest of the session layer, and it
 * applies here with one extra point:
 *
 *  - `ScopedRepository` injects the actor's country/tenant/merchant triple from `ScopeContext`.
 *    A session row has none of those columns, and this code runs from an **interceptor** — which
 *    Nest executes before `TenancyScopeInterceptor` has necessarily populated that context on
 *    every path — so requiring it would be circular in the same way the guards are.
 *  - Every statement below is keyed by the session id **from the verified JWT** (R3) or by a user
 *    id from the same place. There is no caller-supplied identifier anywhere in this file.
 *
 * Access is therefore raw, parameterised SQL through the shared `Sequelize` instance, and
 * deliberately not `PortalSession.update()` — T-013's `no-raw-model-access` rule bans model
 * statics outside `src/common/scope/` and `src/database/`, and this file passes it with no
 * `eslint-disable` (R2).
 *
 * ### `status = 'active'` is on every statement, and it is the real revocation control
 *
 * The task file requires logout to destroy the key. {@link clearForSession} does that explicitly.
 * But the predicate below is what makes *every other* revocation path — password change, password
 * reset, refresh-token reuse detection, tenant suspension, an admin revoking a session — destroy
 * it too, without any of those paths having to know this column exists. A key that can only be
 * read while the session is `active` cannot outlive the session, whoever ended it and however.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { SESSION_STATUS } from '@/modules/auth/session.constants';

/**
 * The port the transport layer depends on. An interface so `HandshakeService` can be unit-tested
 * against an in-memory double, following `SESSION_STORE`/`CREDENTIAL_STORE`.
 */
export interface SessionTransportKeyStore {
  /** Stores the **already-encrypted** key. Returns false when no active session matched. */
  store(sessionId: string, ciphertext: string): Promise<boolean>;
  /** The stored ciphertext for an active session, or `null`. */
  find(sessionId: string): Promise<string | null>;
  /** Destroys one session's key. */
  clearForSession(sessionId: string): Promise<number>;
  /** Destroys every key belonging to a user — `logout-all`. */
  clearForUser(userId: number): Promise<number>;
}

/** DI token — every consumer depends on {@link SessionTransportKeyStore}, never on the class. */
export const SESSION_TRANSPORT_KEY_STORE = Symbol('SESSION_TRANSPORT_KEY_STORE');

@Injectable()
export class SessionTransportKeyRepository implements SessionTransportKeyStore {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async store(sessionId: string, ciphertext: string): Promise<boolean> {
    const [, affected] = await this.sequelize.query(
      `
      UPDATE reward_portal.portal_sessions
         SET transport_key_enc = :ciphertext
       WHERE id = :sessionId AND status = '${SESSION_STATUS.ACTIVE}'
      `,
      { type: QueryTypes.UPDATE, replacements: { sessionId, ciphertext } },
    );

    return affected > 0;
  }

  async find(sessionId: string): Promise<string | null> {
    const rows = await this.sequelize.query<{ transport_key_enc: string | null }>(
      `
      SELECT transport_key_enc
        FROM reward_portal.portal_sessions
       WHERE id = :sessionId AND status = '${SESSION_STATUS.ACTIVE}'
       LIMIT 1
      `,
      { type: QueryTypes.SELECT, replacements: { sessionId } },
    );

    const row = rows[0];
    return row === undefined ? null : row.transport_key_enc;
  }

  /**
   * No `status` predicate here, unlike the two above: this is the *destroy* path, and refusing to
   * clear the key of a session that has already been revoked would leave the ciphertext sitting
   * in the row forever. Destroying is always safe.
   */
  async clearForSession(sessionId: string): Promise<number> {
    const [, affected] = await this.sequelize.query(
      `
      UPDATE reward_portal.portal_sessions
         SET transport_key_enc = NULL
       WHERE id = :sessionId AND transport_key_enc IS NOT NULL
      `,
      { type: QueryTypes.UPDATE, replacements: { sessionId } },
    );

    return affected;
  }

  async clearForUser(userId: number): Promise<number> {
    const [, affected] = await this.sequelize.query(
      `
      UPDATE reward_portal.portal_sessions
         SET transport_key_enc = NULL
       WHERE user_id = :userId AND transport_key_enc IS NOT NULL
      `,
      { type: QueryTypes.UPDATE, replacements: { userId } },
    );

    return affected;
  }
}
