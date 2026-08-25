/**
 * T-048 — the session lifecycle: start, turn, review, confirm, abandon.
 *
 * This is Zone 2's outermost layer. It owns three things the orchestrator deliberately does not:
 * **persistence** (`agent-session.repository.ts`), **the confirmation gate** (§3.2) and
 * **execution** (`portal-api.client.ts`). Keeping them out of the orchestrator is what makes the
 * zone boundary reviewable — the file that talks to the model has no way to persist anything and
 * no way to create anything.
 *
 * ### `assertRole(actor, 'maker')` is here, not only on the controller (TC-20)
 *
 * Three independent layers, exactly as `campaigns.service.ts` documents for the wizard:
 *
 *  1. `@Roles('maker')` — the static, non-runtime-configurable gate (T-013 layer 1);
 *  2. `@RequirePermission('campaign','create')` — the data-driven gate, which a `checker` fails
 *     because T004_001 grants it `view`/`approve`/`reject`/`return` and not `create`;
 *  3. `assertRole(actor, 'maker')` at the top of every method here — independent of both, so one
 *     `UPDATE role_entity_permissions` cannot turn a checker into an author (T-013 TC-19).
 *
 * §2 is emphatic that there is no service account: *"The agent acts as the maker, never as itself
 * … an account that could create campaigns without a responsible human would defeat the entire
 * maker/checker model."* Every method below takes the caller's own `AuthenticatedUser` and passes
 * it, unchanged, to `CampaignsService`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { assertRole } from '@/common/rbac/assert-role';
import { redactForLog } from '@/common/logging/redact';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type {
  AgentCreatedCampaign,
  AgentPlan,
  AgentSession,
  AgentSessionDetail,
  AgentTurn,
} from '@reward-portal/shared';
import {
  AGENT_STATE,
  EVENT_ROLE,
  MAX_TURNS_PER_SESSION,
  STALL_TURNS_BEFORE_WIZARD,
  WIZARD_PATH,
} from './agent.constants';
import {
  PlanHashMismatchError,
  SessionExhaustedError,
  SessionNotActiveError,
} from './agent.errors';
import { AgentSessionRepository, type AgentSessionRow } from './agent-session.repository';
import { AgentOrchestrator, EMPTY_OPTIONS, GREETING } from './agent.orchestrator';
import { PlanTool } from './tools/plan.tool';
import { PlanHashService } from './plan-hash.service';
import { PortalApiClient } from './portal-api.client';

/** How many transcript rows a resume returns. Generous — a conversation is short — but bounded. */
const MAX_TRANSCRIPT_EVENTS = 500;

/** How many sessions the resume picker lists. */
const MAX_SESSIONS_LISTED = 20;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly sessions: AgentSessionRepository,
    private readonly orchestrator: AgentOrchestrator,
    private readonly plans: PlanTool,
    private readonly hasher: PlanHashService,
    private readonly portal: PortalApiClient,
  ) {}

  /**
   * Opens a session and returns the greeting.
   *
   * The greeting is a constant and no model is called (see `agent.orchestrator.ts#GREETING`), so
   * opening the assistant works even while Ollama is down — the maker then learns that on their
   * first message, with the wizard one click away (§9).
   */
  async start(actor: AuthenticatedUser): Promise<AgentTurn> {
    assertRole(actor, 'maker');

    const session = await this.sessions.create();
    await this.sessions.appendEvent(session.id, {
      role: EVENT_ROLE.ASSISTANT,
      content: GREETING,
    });

    return {
      session: toSessionDto(session, null),
      reply: GREETING,
      options: EMPTY_OPTIONS,
      progress: this.orchestrator.progressOf(session.slots, session.noProgressTurns),
      plan: null,
    };
  }

  /** The maker's own sessions, newest first — the resume list (TC-21). */
  async listOwn(actor: AuthenticatedUser): Promise<readonly AgentSession[]> {
    assertRole(actor, 'maker');
    const rows = await this.sessions.listOwn(MAX_SESSIONS_LISTED);
    return rows.map((row) => toSessionDto(row, null));
  }

  /**
   * Resumes a session — *"a maker can resume tomorrow; a reviewer can read exactly what was asked
   * and answered"* (§7, TC-21/TC-22).
   *
   * The transcript is returned in full and in order. The plan is **rebuilt**, never read from the
   * stored copy, for the reason `plan-hash.service.ts` gives: the stored plan is a display
   * artefact, and the only plan that means anything is the one the current answers produce.
   */
  async resume(actor: AuthenticatedUser, sessionId: string): Promise<AgentSessionDetail> {
    assertRole(actor, 'maker');

    const session = await this.sessions.findOwnOrFail(sessionId);
    const events = await this.sessions.listEvents(sessionId, MAX_TRANSCRIPT_EVENTS);
    const plan = await this.rebuildPlanIfPossible(session, actor);

    return {
      session: toSessionDto(session, plan?.planHash ?? null),
      events: events.map((event) => ({
        seq: event.seq,
        role: event.role,
        content: event.content,
        at: event.createdAt.toISOString(),
      })),
      // Options are offered per turn; a resumed session shows the transcript and the answers, and
      // the next message re-offers whatever the next question needs. Replaying a stale option list
      // would show merchants that may since have been deactivated.
      options: EMPTY_OPTIONS,
      progress: this.orchestrator.progressOf(session.slots, session.noProgressTurns),
      plan: plan?.plan ?? null,
    };
  }

  /**
   * One conversational turn.
   *
   * Order matters: the maker's message is persisted **before** the model is consulted, so a model
   * outage cannot lose what they said (TC-22 — the transcript is the record, not a by-product of a
   * successful turn). The assistant's reply and its telemetry are appended after.
   */
  async sendMessage(
    actor: AuthenticatedUser,
    sessionId: string,
    message: string,
  ): Promise<AgentTurn> {
    assertRole(actor, 'maker');

    const session = await this.sessions.findOwnOrFail(sessionId);
    this.assertActive(session);
    if (session.turnCount >= MAX_TURNS_PER_SESSION) throw new SessionExhaustedError();

    await this.sessions.appendEvent(sessionId, { role: EVENT_ROLE.USER, content: message });

    const turn = await this.orchestrator.advance(session.slots, session.offeredOptions, message);

    // §9's stall rule. Counted here rather than in the orchestrator because it is a property of the
    // *session*, and a session outlives any one turn.
    const noProgressTurns = turn.madeProgress ? 0 : session.noProgressTurns + 1;

    // §6 — a violation is something for the maker to hear about now, not at the review panel. The
    // explanations are appended to the reply rather than replacing it, so the model's own wording
    // survives and the deterministic constraint is the last word.
    const violations = await this.orchestrator.explainViolations(turn.slots, session.tenantId);
    const reply =
      violations.length === 0 ? turn.reply : `${turn.reply}\n\n${violations.join('\n')}`;

    const saved = await this.sessions.saveTurn(sessionId, {
      slots: turn.slots,
      offeredOptions: turn.offered,
      // Any answer changing invalidates a previously-built plan: the hash would no longer match
      // what the answers produce, and leaving a stale one on the row would invite a confirm against
      // it. Cleared on every turn, rebuilt on demand.
      plan: null,
      planHash: null,
      noProgressTurns,
      turnCount: session.turnCount + 1,
      state: AGENT_STATE.COLLECTING,
    });

    await this.sessions.appendEvent(sessionId, {
      role: EVENT_ROLE.ASSISTANT,
      content: reply,
      // §7 / TC-23 — model, prompt hash, tokens and latency are recorded by `llm.provider.ts` into
      // the log; what is persisted here is the outcome shape, never prompt content.
      meta: {
        madeProgress: turn.madeProgress,
        missing: turn.progress.missing,
        violationCount: violations.length,
      },
    });

    return {
      session: toSessionDto(saved, null),
      reply,
      options: turn.options,
      progress: {
        ...turn.progress,
        offerWizard: noProgressTurns >= STALL_TURNS_BEFORE_WIZARD,
      },
      plan: null,
    };
  }

  /**
   * §4 step 9 — builds the plan and its hash, and moves the session to `reviewing`.
   *
   * Refuses (422) on incomplete answers or a policy violation; the maker keeps talking. The hash is
   * stored so the *displayed* plan and the session agree, but confirm recomputes it regardless.
   */
  async buildPlan(actor: AuthenticatedUser, sessionId: string): Promise<AgentTurn> {
    assertRole(actor, 'maker');

    const session = await this.sessions.findOwnOrFail(sessionId);
    this.assertActive(session);

    const { plan, planHash } = await this.plans.buildOrThrow(
      session.slots,
      session.offeredOptions,
      session.tenantId,
    );

    const saved = await this.sessions.saveTurn(sessionId, {
      slots: session.slots,
      offeredOptions: session.offeredOptions,
      plan,
      planHash,
      noProgressTurns: session.noProgressTurns,
      turnCount: session.turnCount,
      state: AGENT_STATE.REVIEWING,
    });

    const reply =
      `Here is the whole campaign. Check it over, and if it is right, create it — it will be ` +
      `saved as a draft for you to submit for approval from the wizard.`;

    await this.sessions.appendEvent(sessionId, {
      role: EVENT_ROLE.SYSTEM,
      content: reply,
      meta: { planHash },
    });

    return {
      session: toSessionDto(saved, planHash),
      reply,
      options: EMPTY_OPTIONS,
      progress: this.orchestrator.progressOf(session.slots, session.noProgressTurns),
      plan,
    };
  }

  /**
   * §3.2 — the confirmation gate, and the only path that creates anything.
   *
   * ```
   * rebuild the plan from the stored slots → recompute its hash → compare with the submitted one
   *   → mismatch ⇒ REJECT (nothing created)
   *   → match    ⇒ execute as the maker → DRAFT
   * ```
   *
   * TC-14 is a submitted hash that never matched; TC-15 is one that matched at display time and
   * stopped matching because an answer changed. Both land on the same line, which is the point of
   * rebuilding rather than reloading.
   *
   * **`/submit` is never called** (TC-16). The response's `handOff` says so in words the maker
   * reads, and `portal-api.client.ts` has no method that could.
   */
  async confirm(
    actor: AuthenticatedUser,
    sessionId: string,
    submittedHash: string,
  ): Promise<AgentCreatedCampaign> {
    assertRole(actor, 'maker');

    const session = await this.sessions.findOwnOrFail(sessionId);
    this.assertActive(session);

    // Rebuilt, not reloaded. Also re-runs the policy engine and both option gates, so a merchant
    // deactivated since the review is caught here rather than half-way through execution.
    const { plan } = await this.plans.buildOrThrow(
      session.slots,
      session.offeredOptions,
      session.tenantId,
    );

    if (!this.hasher.matches(plan, submittedHash)) {
      await this.sessions.appendEvent(sessionId, {
        role: EVENT_ROLE.SYSTEM,
        content:
          'The plan changed since it was shown, so nothing was created. Review it again and ' +
          'confirm the new one.',
        meta: { rejected: 'plan_hash_mismatch' },
      });
      throw new PlanHashMismatchError({
        logMessage: 'agent confirm rejected: the recomputed plan hash did not match',
        logContext: { sessionId },
      });
    }

    const campaign = await this.portal.createCampaignDraft(actor, plan, sessionId);
    const saved = await this.sessions.markCreated(sessionId, campaign.id);

    const handOffMessage =
      `Created as draft ${campaign.campaignCode}. Open it in the wizard to review it and submit ` +
      'it for approval — submitting is yours to do, not mine.';

    await this.sessions.appendEvent(sessionId, {
      role: EVENT_ROLE.SYSTEM,
      content: handOffMessage,
      meta: { campaignId: campaign.id, campaignCode: campaign.campaignCode },
    });

    this.logger.log(
      `Agent session created a draft campaign ${JSON.stringify(
        redactForLog({ sessionId, campaignId: campaign.id }),
      )}`,
    );

    return {
      session: toSessionDto(saved, submittedHash),
      campaign,
      handOff: { message: handOffMessage, wizardPath: `${WIZARD_PATH}/${campaign.id}` },
    };
  }

  /** Ends a session without creating anything. Idempotent in effect: abandoning an already-ended
   * session is refused by {@link assertActive}, which is the honest answer rather than a silent OK
   * on a session that may have produced a campaign. */
  async abandon(actor: AuthenticatedUser, sessionId: string): Promise<AgentSession> {
    assertRole(actor, 'maker');

    const session = await this.sessions.findOwnOrFail(sessionId);
    this.assertActive(session);
    const saved = await this.sessions.markState(sessionId, AGENT_STATE.ABANDONED);
    return toSessionDto(saved, null);
  }

  // --- private ------------------------------------------------------------------------------------

  /** `created`, `abandoned` and `error` are terminal. A created session in particular must never
   * accept another turn — it already produced a campaign, and a second one would be a campaign
   * nobody reviewed. */
  private assertActive(session: AgentSessionRow): void {
    if (session.state !== AGENT_STATE.COLLECTING && session.state !== AGENT_STATE.REVIEWING) {
      throw new SessionNotActiveError(session.state);
    }
  }

  /**
   * The plan, if the answers currently support one. `null` otherwise — a resume mid-conversation is
   * the normal case, not an error.
   *
   * Swallows the two "not ready" refusals and **only** those: an incomplete slot store and a policy
   * violation both mean "no plan yet", which is exactly what a resumed conversation shows. Anything
   * else — an option that no longer resolves, a database failure — propagates, because those are
   * things the maker needs to be told about rather than shown as an empty review panel.
   */
  private async rebuildPlanIfPossible(
    session: AgentSessionRow,
    actor: AuthenticatedUser,
  ): Promise<{ plan: AgentPlan; planHash: string } | null> {
    void actor;
    try {
      return await this.plans.buildOrThrow(session.slots, session.offeredOptions, session.tenantId);
    } catch (error) {
      if (isNotReady(error)) return null;
      throw error;
    }
  }
}

/** The two refusals that mean "keep talking", rather than "something is wrong". */
function isNotReady(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'AGENT_PLAN_INCOMPLETE' || code === 'AGENT_POLICY_VIOLATION';
}

/** Row → wire. `campaignCode` is not on the session row, so it is `null` here and carried by the
 * `campaign` object of the confirm response, which is where a client needs it. */
function toSessionDto(row: AgentSessionRow, planHash: string | null): AgentSession {
  return {
    sessionId: row.id,
    state: row.state,
    archetype: row.slots.archetype,
    planHash: planHash ?? row.planHash,
    campaignId: row.campaignId,
    campaignCode: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export { toSessionDto };
