/**
 * T-014 — the one read of `reward_config.system_messages`.
 *
 * Split out from `MessageService` so the service — which owns the caching, refresh and
 * fallback *policy* — can be unit-tested without a database, exactly as T-011 split
 * `SessionRepository` out of `AuthService`. `MESSAGE_STORE` is the DI token every consumer
 * depends on; nothing outside this file names the class.
 *
 * ### Why a raw query rather than `ScopedRepository` (AGENT-PROTOCOL R2)
 *
 * R2 exists to guarantee that data belonging to a tenant is never read without the tenant
 * predicate. `system_messages` is global, Super-Admin-owned reference data with no tenancy
 * columns at all (01-DATABASE.md §5.4), and this read happens **at boot and on a timer** — with
 * no request, and therefore no `ScopeContext`. `ScopedRepository` is explicitly designed to
 * throw in that situation (`MissingScopeContextError`), which is the correct behaviour for
 * tenant data and the wrong tool here. The precedent is T-011's `SessionRepository`, which
 * reads and writes `reward_portal` tables the same way and for the same reason.
 *
 * The query takes no parameters and interpolates nothing, so there is no injection surface to
 * reason about: the SQL text below is a compile-time constant.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';

/** One catalogue entry — the key the API returns and the text the SPA renders. */
export interface SystemMessageRow {
  readonly key: string;
  readonly text: string;
}

/** What `MessageService` depends on. Implemented below; faked in unit tests. */
export interface MessageStore {
  loadAll(): Promise<readonly SystemMessageRow[]>;
}

/** DI token — consumers depend on {@link MessageStore}, never on the class. */
export const MESSAGE_STORE = Symbol('MESSAGE_STORE');

interface RawMessageRow {
  message_key: string;
  message_text: string;
}

@Injectable()
export class SystemMessageRepository implements MessageStore {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async loadAll(): Promise<readonly SystemMessageRow[]> {
    const rows = await this.sequelize.query<RawMessageRow>(
      'SELECT message_key, message_text FROM reward_config.system_messages',
      { type: QueryTypes.SELECT },
    );
    return rows.map((row) => ({ key: row.message_key, text: row.message_text }));
  }
}
