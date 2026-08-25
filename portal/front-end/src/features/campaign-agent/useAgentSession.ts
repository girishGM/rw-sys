/**
 * T-049 — the conversation's state machine: resume-or-start, one turn at a time, review, confirm.
 *
 * Everything this hook holds is either **the server's own answer to the last call** or **the
 * transcript of what has been said**. It derives nothing about the campaign: not whether the
 * answers are complete (`progress.complete`), not whether the wizard should be offered
 * (`progress.offerWizard`), not what the plan contains, not whether a plan may be confirmed. Those
 * are Zone 2's decisions (10-AI-CAMPAIGN-AGENT.md §2), and a second opinion held in a browser is a
 * second opinion that can be edited by whoever owns the browser.
 *
 * ### Resume before start (implementation note 9, TC-15, TC-22)
 *
 * On mount the hook asks for the maker's own sessions and reopens the newest one still
 * `collecting` or `reviewing`; only when there is none does it open a new one. That is what makes
 * "reopening restores the conversation" true without this SPA storing a session id anywhere — no
 * `localStorage` (R5 forbids it for tokens, and a resource id in there would be the same habit
 * with a smaller blast radius), no URL parameter a maker could edit into somebody else's session.
 * The server re-checks ownership on every call regardless (`findOwnOrFail`); this is just the
 * client not needing to remember anything.
 *
 * ### One request in flight, always
 *
 * `busy` gates every action. A conversation is inherently sequential — turn *n+1* is a function of
 * the slot store turn *n* wrote — so two concurrent messages would race for the same session row
 * and the maker would read the replies in whichever order they landed.
 *
 * ### Failures are classified, never rendered raw
 *
 * {@link classifyFailure} maps the five outcomes that mean different things to a maker: the model
 * is down (§9 — offer the wizard), the turn stalled (retry), the network dropped (reconnect), the
 * deterministic policy engine refused (§6 — read the constraint), and everything else. The
 * `message` shown always comes from the server where there is one (04-FRONTEND.md §8 note 5:
 * *"feature code renders `message` and never invents its own copy for a server-side failure"*).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AgentCreatedCampaign,
  AgentOption,
  AgentOptions,
  AgentPlan,
  AgentProgress,
  AgentSession,
  AgentSessionDetail,
  AgentTurn,
} from '@reward-portal/shared';
import { ApiError } from '../../lib/apiError';
import { CAMPAIGNS_ROOT_KEY } from '../campaigns/api';
import {
  AGENT_TIMEOUT_CODE,
  abandonAgentSession,
  buildAgentPlan,
  confirmAgentPlan,
  listAgentSessions,
  resumeAgentSession,
  sendAgentMessage,
  startAgentSession,
} from './api';

/** One rendered turn. `role` is the transcript's own vocabulary (`agent_session_events.role`),
 * minus `tool` — tool rows carry no `content` a maker would read. */
export interface AgentChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly text: string;
}

export type AgentFailureKind = 'unavailable' | 'timeout' | 'network' | 'policy' | 'other';

export interface AgentFailure {
  readonly kind: AgentFailureKind;
  /** The server's own text where there was one; a client sentence only for client-only failures. */
  readonly message: string;
  /** `details[].code` from the server envelope — the policy-violation codes, in particular. */
  readonly codes: readonly string[];
  /** Whether "Try again" is a sensible offer for this failure. */
  readonly retryable: boolean;
}

/** The four option kinds a turn can offer, as `agentOptionsSchema` keys them. */
export type AgentOptionKind = keyof AgentOptions;

/** Merchants and activities are answered with a set; a rule or a reward is answered with one. */
export const MULTI_SELECT_KINDS: readonly AgentOptionKind[] = ['merchants', 'activities'];

const EMPTY_OPTIONS: AgentOptions = { merchants: [], activities: [], rules: [], rewards: [] };

/** Codes and statuses that mean "the model is not answering" (§9, `LlmUnavailableError` = 503). */
function isUnavailable(error: ApiError): boolean {
  return error.code === 'AGENT_LLM_UNAVAILABLE' || error.status === 503;
}

export function classifyFailure(error: unknown): AgentFailure {
  if (!(error instanceof ApiError)) {
    return {
      kind: 'other',
      message: error instanceof Error ? error.message : 'Something went wrong. Please try again.',
      codes: [],
      retryable: true,
    };
  }

  const codes = (error.details ?? []).map((detail) => detail.code);

  if (isUnavailable(error)) {
    return { kind: 'unavailable', message: error.message, codes, retryable: true };
  }
  if (error.code === AGENT_TIMEOUT_CODE) {
    return { kind: 'timeout', message: error.message, codes, retryable: true };
  }
  if (error.code === 'NETWORK_ERROR' || error.status === 0) {
    return { kind: 'network', message: error.message, codes, retryable: true };
  }
  if (error.code === 'AGENT_POLICY_VIOLATION' || error.code === 'AGENT_PLAN_INCOMPLETE') {
    return { kind: 'policy', message: error.message, codes, retryable: false };
  }
  return { kind: 'other', message: error.message, codes, retryable: true };
}

/**
 * The sentence a chip selection sends.
 *
 * It carries the **`optionId`** verbatim, because that token is the only thing the model may put
 * in a slot: it was minted by the server for this session, it is re-checked against the maker's
 * live scope before it can become an id (10-AI §3.1), and a label alone would leave the model
 * guessing which row a name meant. It is shown to the maker exactly as it is sent — the transcript
 * is an audit record (§7), and a transcript that says something other than what was sent is worse
 * than a slightly technical one.
 */
export function selectionMessage(kind: AgentOptionKind, chosen: readonly AgentOption[]): string {
  const noun = SELECTION_NOUN[kind];
  const parts = chosen.map((option) =>
    option.subtitle === null || option.subtitle === ''
      ? `${option.label} (${option.optionId})`
      : `${option.label} — ${option.subtitle} (${option.optionId})`,
  );
  return `I choose ${noun}: ${parts.join(', ')}`;
}

const SELECTION_NOUN: Readonly<Record<AgentOptionKind, string>> = {
  merchants: 'these merchants',
  activities: 'these activities',
  rules: 'this rule',
  rewards: 'this reward',
};

let messageCounter = 0;
function nextMessageId(prefix: string): string {
  messageCounter += 1;
  return `${prefix}-${String(messageCounter)}`;
}

function toMessage(role: AgentChatMessage['role'], text: string): AgentChatMessage {
  return { id: nextMessageId(role), role, text };
}

export interface UseAgentSessionResult {
  readonly messages: readonly AgentChatMessage[];
  readonly session: AgentSession | null;
  readonly options: AgentOptions;
  readonly progress: AgentProgress | null;
  readonly plan: AgentPlan | null;
  readonly created: AgentCreatedCampaign | null;
  readonly failure: AgentFailure | null;
  /** True while a call is in flight — drives the typing indicator and disables every control. */
  readonly busy: boolean;
  /** True until the first bootstrap call settles. */
  readonly starting: boolean;
  /** §9 — the model is down, or the conversation has stalled for three turns. */
  readonly offerWizard: boolean;
  readonly send: (text: string) => void;
  readonly choose: (kind: AgentOptionKind, chosen: readonly AgentOption[]) => void;
  readonly requestPlan: () => void;
  readonly confirmPlan: () => void;
  /** "Change something" — dismisses the review panel and keeps every answer. */
  readonly keepEditing: () => void;
  readonly retry: () => void;
  readonly restart: () => void;
}

export function useAgentSession(): UseAgentSessionResult {
  const queryClient = useQueryClient();

  const [messages, setMessages] = useState<readonly AgentChatMessage[]>([]);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [options, setOptions] = useState<AgentOptions>(EMPTY_OPTIONS);
  const [progress, setProgress] = useState<AgentProgress | null>(null);
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [created, setCreated] = useState<AgentCreatedCampaign | null>(null);
  const [failure, setFailure] = useState<AgentFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(true);

  /** The message whose turn did not complete, so `retry` knows what to re-send (TC-11, TC-22). */
  const pendingMessage = useRef<string | null>(null);
  /** Guards the bootstrap against React 18 StrictMode's deliberate double-effect. */
  const bootstrapped = useRef(false);
  /** Set on unmount so a late-resolving turn cannot call `setState` on a dead component. */
  const alive = useRef(true);

  const applyTurn = useCallback((turn: AgentTurn) => {
    setSession(turn.session);
    setOptions(turn.options);
    setProgress(turn.progress);
    setPlan(turn.plan);
    setMessages((current) => [...current, toMessage('assistant', turn.reply)]);
  }, []);

  const applyDetail = useCallback((detail: AgentSessionDetail) => {
    setSession(detail.session);
    setOptions(detail.options);
    setProgress(detail.progress);
    setPlan(detail.plan);
    setMessages(
      detail.events
        .filter((event) => event.role !== 'tool' && event.content !== null)
        .map((event) => ({
          id: `event-${String(event.seq)}`,
          role: event.role === 'user' ? 'user' : event.role === 'system' ? 'system' : 'assistant',
          text: event.content ?? '',
        })),
    );
  }, []);

  /** Resume the newest live session, or open a new one. See this file's header. */
  const bootstrap = useCallback(async () => {
    setStarting(true);
    setFailure(null);
    try {
      const sessions = await listAgentSessions();
      const live = sessions.find(
        (candidate) => candidate.state === 'collecting' || candidate.state === 'reviewing',
      );
      if (live !== undefined) {
        applyDetail(await resumeAgentSession(live.sessionId));
      } else {
        setMessages([]);
        applyTurn(await startAgentSession());
      }
    } catch (error) {
      if (alive.current) setFailure(classifyFailure(error));
    } finally {
      if (alive.current) setStarting(false);
    }
  }, [applyDetail, applyTurn]);

  useEffect(() => {
    alive.current = true;
    if (!bootstrapped.current) {
      bootstrapped.current = true;
      void bootstrap();
    }
    return () => {
      alive.current = false;
    };
  }, [bootstrap]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '' || session === null || busy) return;

      pendingMessage.current = trimmed;
      setMessages((current) => [...current, toMessage('user', trimmed)]);
      setFailure(null);
      setBusy(true);

      void (async () => {
        try {
          const turn = await sendAgentMessage(session.sessionId, trimmed);
          if (!alive.current) return;
          pendingMessage.current = null;
          applyTurn(turn);
        } catch (error) {
          if (alive.current) setFailure(classifyFailure(error));
        } finally {
          if (alive.current) setBusy(false);
        }
      })();
    },
    [applyTurn, busy, session],
  );

  const choose = useCallback(
    (kind: AgentOptionKind, chosen: readonly AgentOption[]) => {
      if (chosen.length === 0) return;
      // The chips are cleared immediately: they belong to the turn that offered them, and a stale
      // list is a list of merchants that may since have been deactivated (`agent.service.ts`
      // makes the same call for a resumed session).
      setOptions(EMPTY_OPTIONS);
      send(selectionMessage(kind, chosen));
    },
    [send],
  );

  const requestPlan = useCallback(() => {
    if (session === null || busy) return;
    setFailure(null);
    setBusy(true);

    void (async () => {
      try {
        const turn = await buildAgentPlan(session.sessionId);
        if (!alive.current) return;
        applyTurn(turn);
      } catch (error) {
        if (alive.current) setFailure(classifyFailure(error));
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  }, [applyTurn, busy, session]);

  const confirmPlan = useCallback(() => {
    if (session === null || session.planHash === null || busy) return;
    const planHash = session.planHash;
    setFailure(null);
    setBusy(true);

    void (async () => {
      try {
        const result = await confirmAgentPlan(session.sessionId, planHash);
        if (!alive.current) return;
        setCreated(result);
        setSession(result.session);
        setPlan(null);
        setOptions(EMPTY_OPTIONS);
        setMessages((current) => [...current, toMessage('system', result.handOff.message)]);
        // The one cache this feature invalidates: the draft it just created belongs in
        // "My Campaigns" the moment the maker follows the hand-off link.
        void queryClient.invalidateQueries({ queryKey: CAMPAIGNS_ROOT_KEY });
      } catch (error) {
        if (alive.current) setFailure(classifyFailure(error));
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  }, [busy, queryClient, session]);

  /**
   * "Change something" — hides the plan and lets the maker keep talking.
   *
   * Nothing is sent and nothing is discarded: the answers live in the session's slot store, and
   * the next message re-collects from wherever the agent is (TC-9). The plan is dropped from local
   * state because it is now provisional — the server clears its own copy on the next turn for the
   * same reason (`agent.service.ts#sendMessage`).
   */
  const keepEditing = useCallback(() => {
    setPlan(null);
  }, []);

  /**
   * Recovers from a stalled turn or a dropped connection.
   *
   * Re-reads the session from the server first — that transcript is the record, not this
   * component's copy — and only re-sends the pending message when the server never saw it. A turn
   * that landed but whose response was lost is therefore not duplicated (TC-22).
   */
  const retry = useCallback(() => {
    if (busy) return;
    if (session === null) {
      void bootstrap();
      return;
    }

    setFailure(null);
    setBusy(true);

    void (async () => {
      try {
        const detail = await resumeAgentSession(session.sessionId);
        if (!alive.current) return;
        applyDetail(detail);

        const pending = pendingMessage.current;
        const landed =
          pending !== null &&
          detail.events.some((event) => event.role === 'user' && event.content === pending);
        if (pending !== null && !landed) {
          const turn = await sendAgentMessage(session.sessionId, pending);
          if (!alive.current) return;
          setMessages((current) => [...current, toMessage('user', pending)]);
          pendingMessage.current = null;
          applyTurn(turn);
        } else {
          pendingMessage.current = null;
        }
      } catch (error) {
        if (alive.current) setFailure(classifyFailure(error));
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  }, [applyDetail, applyTurn, bootstrap, busy, session]);

  /** Abandons the current conversation and opens a fresh one. The abandoned session keeps its
   * transcript — §7's append-only record — it simply stops being the one that resumes. */
  const restart = useCallback(() => {
    if (busy) return;
    setBusy(true);

    void (async () => {
      try {
        if (session !== null && (session.state === 'collecting' || session.state === 'reviewing')) {
          await abandonAgentSession(session.sessionId);
        }
        if (!alive.current) return;
        setCreated(null);
        setPlan(null);
        setFailure(null);
        setMessages([]);
        pendingMessage.current = null;
        applyTurn(await startAgentSession());
      } catch (error) {
        if (alive.current) setFailure(classifyFailure(error));
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  }, [applyTurn, busy, session]);

  return {
    messages,
    session,
    options,
    progress,
    plan,
    created,
    failure,
    busy,
    starting,
    offerWizard: failure?.kind === 'unavailable' || progress?.offerWizard === true,
    send,
    choose,
    requestPlan,
    confirmPlan,
    keepEditing,
    retry,
    restart,
  };
}
