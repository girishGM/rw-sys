/**
 * T-048 — `reward_portal.agent_sessions` / `agent_session_events` (10-AI-CAMPAIGN-AGENT.md §7).
 *
 * ### Why this uses parameterised SQL rather than `ScopedRepository`, and why that is not an R2
 * loophole
 *
 * `ScopedRepository` needs a **model**, and a model needs two files this task does not own:
 * `src/database/portal-models/*` and `src/common/scope/scope-strategy.ts` (whose own header is
 * explicit that *"a Wave 3 agent adding a table must state, in this file, how each role reaches
 * it"*). Both belong to T-003/T-013, both are `done`, and R9 forbids editing another task's owned
 * files. The precedent for the alternative is already established twice in this codebase and was
 * accepted by review both times — `credential.repository.ts` (T-010, `portal_user_credentials`)
 * and `grpc-grants.service.ts` (T-047, `grpc_service_grants`). This file follows the same shape
 * and the same discipline:
 *
 *  - **The scope is not optional and does not come from the caller.** Every statement below is
 *    filtered on `portal_user_id` *and* `tenant_id`, taken from {@link ScopeContext.require} —
 *    the same `AsyncLocalStorage` value `ScopedRepository` reads, populated only by
 *    `TenancyScopeInterceptor` from the verified JWT. There is no method here that accepts a
 *    user id or a tenant id as an argument, so there is no call site at which the wrong one could
 *    be passed (R3).
 *  - **Absent scope is a hard failure, never an unscoped query.** `require()` throws
 *    `MissingScopeContextError` → 500. That is `ScopedRepository`'s own fail-closed property,
 *    reproduced rather than approximated.
 *  - **No value is interpolated into SQL text.** Every one binds through Sequelize
 *    `replacements`. The R2 lint rule is untouched: there is no raw model access here either,
 *    because this table has no model.
 *
 * A maker therefore cannot read, resume or continue another maker's session, and cannot reach one
 * in another tenant even if they somehow learned its uuid — the row simply is not in the result
 * set, so the outcome is a 404, indistinguishable from "no such session" (02-SECURITY.md §5.1).
 *
 * ### Events are append-only in privilege, not merely in intention
 *
 * `T048_001` grants `reward_app` `SELECT, INSERT` on `agent_session_events` and revokes the rest,
 * so {@link appendEvent} is the only thing that can happen to a transcript. `seq` is allocated
 * inside the same statement that inserts (`SELECT coalesce(max(seq),0)+1`), and `uq_ase_seq`
 * turns a concurrent double-append into a constraint violation rather than two rows claiming the
 * same position — TC-22's *"append-only; full Q&A readable"* is a claim about ordering as much as
 * about immutability.
 */
import { Inject, Injectable } from '@nestjs/common';
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ScopeContext } from '@/common/scope/scope-context';
import { NotFoundError } from '@/common/errors/app-error';
import type { AgentSessionState } from '@reward-portal/shared';
import { AGENT_STATE, EVENT_ROLE } from './agent.constants';
import { agentSlotsSchema, emptySlots, type AgentSlots } from './agent.state';
import { emptyOffered, type OfferedOptions } from './option-resolver.service';

/** One `agent_sessions` row, as the rest of the module sees it. */
export interface AgentSessionRow {
  readonly id: string;
  readonly tenantId: number;
  readonly portalUserId: number;
  readonly state: AgentSessionState;
  readonly slots: AgentSlots;
  readonly offeredOptions: OfferedOptions;
  readonly planHash: string | null;
  readonly campaignId: number | null;
  readonly noProgressTurns: number;
  readonly turnCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One `agent_session_events` row. */
export interface AgentEventRow {
  readonly seq: number;
  readonly role: (typeof EVENT_ROLE)[keyof typeof EVENT_ROLE];
  readonly content: string | null;
  readonly createdAt: Date;
}

interface RawSession {
  id: string;
  tenant_id: number;
  portal_user_id: number;
  state: string;
  slots: unknown;
  offered_options: unknown;
  plan_hash: string | null;
  campaign_id: number | null;
  no_progress_turns: number;
  turn_count: number;
  created_at: Date;
  updated_at: Date;
}

interface RawEvent {
  seq: number;
  role: string;
  content: string | null;
  created_at: Date;
}

const SESSION_COLUMNS =
  'id, tenant_id, portal_user_id, state, slots, offered_options, plan_hash, campaign_id, ' +
  'no_progress_turns, turn_count, created_at, updated_at';

/** The owner clause every statement in this file carries. See the header. */
const OWNED = 'portal_user_id = :userId AND tenant_id = :tenantId';

/**
 * `agent_sessions.id` is a `uuid`, and Postgres **errors** rather than returning no rows when a
 * non-uuid is compared against one (`invalid input syntax for type uuid`).
 *
 * Left unguarded that is a 500, and — worse — a 500 that is *distinguishable* from the 404 a
 * well-formed id belonging to another maker produces. An attacker could then tell "that id is
 * syntactically a session" from "that id is not", which is precisely the distinction
 * 02-SECURITY.md §5.1 exists to remove. So the shape is checked in application code and a
 * malformed id takes the same 404 path as a stranger's.
 */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

@Injectable()
export class AgentSessionRepository {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  /**
   * Opens a session for the current actor.
   *
   * `tenant_id` comes from the scope, so a `super_admin` — whose scope carries no tenant — cannot
   * open one at all. That is correct rather than an omission: `assertRole(actor, 'maker')` refuses
   * them one line earlier, and a Super Admin cannot create a campaign in the wizard either.
   */
  async create(transaction?: Transaction): Promise<AgentSessionRow> {
    const { userId, tenantId } = this.owner();
    const [row] = await this.sequelize.query<RawSession>(
      `INSERT INTO reward_portal.agent_sessions (tenant_id, portal_user_id, state, slots, offered_options)
            VALUES (:tenantId, :userId, :state, :slots::jsonb, :offered::jsonb)
         RETURNING ${SESSION_COLUMNS}`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          tenantId,
          userId,
          state: AGENT_STATE.COLLECTING,
          slots: JSON.stringify(emptySlots()),
          offered: JSON.stringify(emptyOffered()),
        },
      },
    );
    return toSession(row);
  }

  /** The actor's own session, or a 404. A session belonging to anyone else is not distinguishable
   * from one that does not exist — the `OWNED` clause is in the WHERE, not in an `if`. */
  async findOwnOrFail(sessionId: string, transaction?: Transaction): Promise<AgentSessionRow> {
    this.assertSessionId(sessionId);
    const { userId, tenantId } = this.owner();
    const rows = await this.sequelize.query<RawSession>(
      `SELECT ${SESSION_COLUMNS} FROM reward_portal.agent_sessions
        WHERE id = :sessionId AND ${OWNED}`,
      { type: QueryTypes.SELECT, transaction, replacements: { sessionId, userId, tenantId } },
    );
    if (rows.length === 0) {
      throw new NotFoundError({ logMessage: 'agent session not found or not the caller’s' });
    }
    return toSession(rows[0]);
  }

  /** The actor's sessions, newest activity first — the resume picker (TC-21). */
  async listOwn(limit: number): Promise<readonly AgentSessionRow[]> {
    const { userId, tenantId } = this.owner();
    const rows = await this.sequelize.query<RawSession>(
      `SELECT ${SESSION_COLUMNS} FROM reward_portal.agent_sessions
        WHERE ${OWNED}
        ORDER BY updated_at DESC
        LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { userId, tenantId, limit } },
    );
    return rows.map(toSession);
  }

  /**
   * Persists the conversational state after a turn.
   *
   * Deliberately narrow: `slots`, `offered_options`, `plan`, `plan_hash` and the two counters, and
   * nothing else. There is no method on this class that can change `tenant_id`, `portal_user_id`
   * or `id`, which is the same guarantee `ScopedRepository#update` provides by refusing to write
   * scope columns (T-013 TC-14) — expressed here as an absent capability rather than a check.
   */
  async saveTurn(
    sessionId: string,
    patch: {
      readonly slots: AgentSlots;
      readonly offeredOptions: OfferedOptions;
      readonly plan: unknown | null;
      readonly planHash: string | null;
      readonly noProgressTurns: number;
      readonly turnCount: number;
      readonly state: AgentSessionState;
    },
    transaction?: Transaction,
  ): Promise<AgentSessionRow> {
    this.assertSessionId(sessionId);
    const { userId, tenantId } = this.owner();
    const rows = await this.sequelize.query<RawSession>(
      `UPDATE reward_portal.agent_sessions
          SET slots             = :slots::jsonb,
              offered_options   = :offered::jsonb,
              plan              = :plan::jsonb,
              plan_hash         = :planHash,
              no_progress_turns = :noProgress,
              turn_count        = :turnCount,
              state             = :state,
              archetype         = :archetype,
              updated_at        = now()
        WHERE id = :sessionId AND ${OWNED}
    RETURNING ${SESSION_COLUMNS}`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          sessionId,
          userId,
          tenantId,
          slots: JSON.stringify(patch.slots),
          offered: JSON.stringify(patch.offeredOptions),
          plan: patch.plan === null ? null : JSON.stringify(patch.plan),
          planHash: patch.planHash,
          noProgress: patch.noProgressTurns,
          turnCount: patch.turnCount,
          state: patch.state,
          archetype: patch.slots.archetype,
        },
      },
    );
    if (rows.length === 0) {
      throw new NotFoundError({ logMessage: 'agent session vanished mid-turn' });
    }
    return toSession(rows[0]);
  }

  /**
   * The terminal transition. `campaign_id` is set **only** here and **only** with
   * `state = 'created'`, which `ck_as_campaign` (T048_001) also enforces — so a session that names
   * a campaign it did not create, or created one it does not name, is rejected by the database as
   * well as by this method.
   */
  async markCreated(
    sessionId: string,
    campaignId: number,
    transaction?: Transaction,
  ): Promise<AgentSessionRow> {
    this.assertSessionId(sessionId);
    const { userId, tenantId } = this.owner();
    const rows = await this.sequelize.query<RawSession>(
      `UPDATE reward_portal.agent_sessions
          SET state = :state, campaign_id = :campaignId, updated_at = now()
        WHERE id = :sessionId AND ${OWNED}
    RETURNING ${SESSION_COLUMNS}`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          sessionId,
          userId,
          tenantId,
          campaignId,
          state: AGENT_STATE.CREATED,
        },
      },
    );
    if (rows.length === 0) {
      throw new NotFoundError({ logMessage: 'agent session not found while marking it created' });
    }
    return toSession(rows[0]);
  }

  /** `abandoned` / `error` — the two ways a session ends without a campaign. */
  async markState(
    sessionId: string,
    state: AgentSessionState,
    transaction?: Transaction,
  ): Promise<AgentSessionRow> {
    this.assertSessionId(sessionId);
    const { userId, tenantId } = this.owner();
    const rows = await this.sequelize.query<RawSession>(
      `UPDATE reward_portal.agent_sessions
          SET state = :state, updated_at = now()
        WHERE id = :sessionId AND ${OWNED}
    RETURNING ${SESSION_COLUMNS}`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: { sessionId, userId, tenantId, state },
      },
    );
    if (rows.length === 0) {
      throw new NotFoundError({ logMessage: 'agent session not found while changing its state' });
    }
    return toSession(rows[0]);
  }

  // --- the transcript ---------------------------------------------------------------------------

  /**
   * Appends one turn. `seq` is allocated in the same statement, so two concurrent appends either
   * order themselves or collide on `uq_ase_seq` — never silently overwrite.
   *
   * `content` is the human-readable turn. `meta` carries §7's telemetry (model, prompt **hash**,
   * token counts, latency) and **never** prompt content; the caller is responsible for that
   * distinction and `llm.provider.ts` is what makes it easy to honour, because the only prompt
   * artefact it hands back is already a hash.
   */
  async appendEvent(
    sessionId: string,
    event: {
      readonly role: (typeof EVENT_ROLE)[keyof typeof EVENT_ROLE];
      readonly content: string | null;
      readonly meta?: Record<string, unknown> | null;
    },
    transaction?: Transaction,
  ): Promise<void> {
    this.assertSessionId(sessionId);
    const { userId, tenantId } = this.owner();
    await this.sequelize.query(
      `INSERT INTO reward_portal.agent_session_events (session_id, seq, role, content, meta)
       SELECT s.id,
              coalesce((SELECT max(e.seq) FROM reward_portal.agent_session_events e
                         WHERE e.session_id = s.id), 0) + 1,
              :role, :content, :meta::jsonb
         FROM reward_portal.agent_sessions s
        WHERE s.id = :sessionId AND s.${OWNED}`,
      {
        type: QueryTypes.INSERT,
        transaction,
        replacements: {
          sessionId,
          userId,
          tenantId,
          role: event.role,
          content: event.content,
          meta: event.meta === undefined || event.meta === null ? null : JSON.stringify(event.meta),
        },
      },
    );
  }

  /** The whole transcript, in order (TC-22). The owner clause is joined through the session, so an
   * event of somebody else's session is unreachable even by id. */
  async listEvents(sessionId: string, limit: number): Promise<readonly AgentEventRow[]> {
    this.assertSessionId(sessionId);
    const { userId, tenantId } = this.owner();
    const rows = await this.sequelize.query<RawEvent>(
      `SELECT e.seq, e.role, e.content, e.created_at
         FROM reward_portal.agent_session_events e
         JOIN reward_portal.agent_sessions s ON s.id = e.session_id
        WHERE e.session_id = :sessionId AND s.${OWNED}
        ORDER BY e.seq
        LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { sessionId, userId, tenantId, limit } },
    );
    return rows.map((row) => ({
      seq: row.seq,
      role: row.role as AgentEventRow['role'],
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  // --- private ----------------------------------------------------------------------------------

  /**
   * The actor, from the verified scope and nowhere else.
   *
   * `tenantId` is asserted non-null rather than defaulted: a role whose scope carries no tenant has
   * no business owning an agent session, and a `null` reaching the SQL would silently widen `OWNED`
   * from "mine" to "every session with a null tenant". Failing here instead is fail-closed.
   */
  /** See {@link UUID_PATTERN}. A malformed id is "not found", never a 500. */
  private assertSessionId(sessionId: string): void {
    if (!UUID_PATTERN.test(sessionId)) {
      throw new NotFoundError({ logMessage: 'agent session id is not a uuid' });
    }
  }

  private owner(): { userId: number; tenantId: number } {
    const scope = ScopeContext.require('agent_sessions');
    if (scope.tenantId === null) {
      throw new NotFoundError({
        logMessage: 'agent sessions are tenant-scoped; this actor has no tenant',
        logContext: { role: scope.role },
      });
    }
    return { userId: scope.userId, tenantId: scope.tenantId };
  }
}

/**
 * Row → domain, re-parsing the two `jsonb` columns.
 *
 * The columns are `jsonb`, so their contents are data of unknown shape until validated —
 * a row written by an older build, or by hand, is exactly as untrusted as a request body. A parse
 * failure degrades to the empty value rather than throwing: a corrupted slot store should cost the
 * maker their conversation, not a 500 on the session list that hides every other session too.
 */
function toSession(row: RawSession): AgentSessionRow {
  const slots = agentSlotsSchema.safeParse(row.slots);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    portalUserId: row.portal_user_id,
    state: row.state as AgentSessionState,
    slots: slots.success ? slots.data : emptySlots(),
    offeredOptions: parseOffered(row.offered_options),
    planHash: row.plan_hash,
    campaignId: row.campaign_id,
    noProgressTurns: row.no_progress_turns,
    turnCount: row.turn_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The offered set, defensively.
 *
 * Every entry must be a string; anything else is dropped. This is the set that decides whether an
 * option the model named was ever offered (TC-7/TC-10), so "malformed → empty" is the only safe
 * degradation: an empty offered set rejects everything, which fails the turn. A permissive parse
 * would fail *open*.
 */
function parseOffered(value: unknown): OfferedOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyOffered();
  const source = value as Record<string, unknown>;
  const kinds = ['merchants', 'activities', 'rules', 'rewards'] as const;
  const out = emptyOffered() as { -readonly [K in keyof OfferedOptions]: string[] };
  for (const kind of kinds) {
    const list = source[kind];
    out[kind] = Array.isArray(list)
      ? list.filter((item): item is string => typeof item === 'string')
      : [];
  }
  return out;
}
