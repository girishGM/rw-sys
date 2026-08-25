/**
 * T-049 — the `/campaign-agent` calls, following the shape `features/campaigns/api.ts` (T-037)
 * establishes: `lib/apiClient.ts`'s shared `api` instance, and every response parsed through the
 * matching schema in `packages/shared/src/campaign.schema.ts` — not just cast — so a server/SPA
 * contract drift surfaces here, as a caught and reported error, rather than as a silent
 * `undefined` deep inside a chat bubble.
 *
 * ### Why there is no `useQuery`/`useMutation` layer in this file
 *
 * Every other feature's `api.ts` wraps its calls in TanStack Query hooks, because every other
 * feature reads *resources*: a list, a detail, a picker — things worth caching and invalidating.
 * A conversation is not a resource. It is an ordered sequence of turns whose only cacheable
 * artefact (the session) is re-read from the server on resume anyway, and whose ordering is the
 * whole point. `useAgentSession.ts` therefore drives these functions directly; the one place a
 * cache does matter — "My Campaigns" after a draft is created — is invalidated explicitly there.
 *
 * ### The 30-second stall guard lives here, not in an interceptor
 *
 * Implementation note 6: *"a stalled stream times out at 30 s with a retry, never an infinite
 * spinner"*. A model turn is the only call in this SPA that legitimately takes tens of seconds, so
 * the bound is applied per call rather than globally on the shared client, where it would also
 * apply to every other feature. {@link AGENT_TIMEOUT_CODE} is deliberately distinguishable from
 * `NETWORK_ERROR`: "the assistant did not answer in 30 s" and "you are offline" are different
 * situations for a maker, and only the first one is worth a plain retry button.
 */
import { z } from 'zod';
import {
  agentCreatedCampaignEnvelopeSchema,
  agentSessionDetailEnvelopeSchema,
  agentSessionListEnvelopeSchema,
  agentSessionSchema,
  agentTurnEnvelopeSchema,
  type AgentCreatedCampaign,
  type AgentSession,
  type AgentSessionDetail,
  type AgentTurn,
} from '@reward-portal/shared';
import { api } from '../../lib/apiClient';
import { ApiError, toApiError } from '../../lib/apiError';

/** Every route of the agent surface hangs off this path (`agent.controller.ts`). */
const SESSIONS_PATH = '/campaign-agent/sessions';

/** Implementation note 6 — the stall bound, in milliseconds. */
export const AGENT_TURN_TIMEOUT_MS = 30_000;

/** The client-side code a timed-out turn rejects with. Not a server code: no server produced it. */
export const AGENT_TIMEOUT_CODE = 'AGENT_TURN_TIMEOUT';

const AGENT_TIMEOUT_MESSAGE =
  'The assistant did not answer within 30 seconds. You can try that message again, or carry on in the wizard.';

/** Parses `payload` or throws a readable contract error — the same helper `campaigns/api.ts` uses,
 * and for the same reason: one copy per feature beats nine hand-written copies, one of which
 * eventually forgets to parse at all. */
function parsed<T>(
  schema: {
    safeParse: (input: unknown) => { success: boolean; data?: T; error?: { message: string } };
  },
  payload: unknown,
  what: string,
): T {
  const result = schema.safeParse(payload);
  if (!result.success || result.data === undefined) {
    throw new Error(
      `${what} response did not match the expected shape: ${result.error?.message ?? ''}`,
    );
  }
  return result.data;
}

/**
 * Runs one request under a wall-clock bound, aborting it and rejecting with
 * {@link AGENT_TIMEOUT_CODE} when the bound is reached.
 *
 * `timedOut` is captured in this closure rather than read back off the error, because an aborted
 * axios request and a request the *user* navigated away from produce the same `CanceledError` —
 * only the code that started the timer knows which of the two happened.
 */
async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = AGENT_TURN_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await run(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new ApiError({
        code: AGENT_TIMEOUT_CODE,
        message: AGENT_TIMEOUT_MESSAGE,
        status: 0,
        cause: error,
      });
    }
    throw toApiError(error);
  } finally {
    clearTimeout(timer);
  }
}

/** `POST /campaign-agent/sessions` — opens a conversation and returns the greeting. */
export async function startAgentSession(): Promise<AgentTurn> {
  try {
    const response = await api.post<unknown>(SESSIONS_PATH, {});
    return parsed(agentTurnEnvelopeSchema, response.data, 'Start assistant session').data;
  } catch (error) {
    throw toApiError(error);
  }
}

/** `GET /campaign-agent/sessions` — the maker's own sessions, newest first. */
export async function listAgentSessions(): Promise<readonly AgentSession[]> {
  try {
    const response = await api.get<unknown>(SESSIONS_PATH);
    return parsed(agentSessionListEnvelopeSchema, response.data, 'Assistant sessions').data;
  } catch (error) {
    throw toApiError(error);
  }
}

/** `GET /campaign-agent/sessions/:id` — resume, transcript included (implementation note 9). */
export async function resumeAgentSession(sessionId: string): Promise<AgentSessionDetail> {
  try {
    const response = await api.get<unknown>(`${SESSIONS_PATH}/${sessionId}`);
    return parsed(agentSessionDetailEnvelopeSchema, response.data, 'Assistant session').data;
  } catch (error) {
    throw toApiError(error);
  }
}

/** `POST /campaign-agent/sessions/:id/messages` — one turn, under the stall bound. */
export async function sendAgentMessage(sessionId: string, message: string): Promise<AgentTurn> {
  return withTimeout(async (signal) => {
    const response = await api.post<unknown>(
      `${SESSIONS_PATH}/${sessionId}/messages`,
      { message },
      { signal },
    );
    return parsed(agentTurnEnvelopeSchema, response.data, 'Assistant reply').data;
  });
}

/** `POST /campaign-agent/sessions/:id/plan` — builds the plan the review panel shows. */
export async function buildAgentPlan(sessionId: string): Promise<AgentTurn> {
  return withTimeout(async (signal) => {
    const response = await api.post<unknown>(`${SESSIONS_PATH}/${sessionId}/plan`, {}, { signal });
    return parsed(agentTurnEnvelopeSchema, response.data, 'Assistant plan').data;
  });
}

/**
 * `POST /campaign-agent/sessions/:id/confirm` — the one call that creates anything.
 *
 * The body is the plan **hash** and nothing else. The plan itself is never sent back: the server
 * rebuilds it from the maker's own answers and refuses on a mismatch (10-AI §3.2), so a client
 * that submitted a plan would be submitting a plan of its own choosing.
 */
export async function confirmAgentPlan(
  sessionId: string,
  planHash: string,
): Promise<AgentCreatedCampaign> {
  try {
    const response = await api.post<unknown>(`${SESSIONS_PATH}/${sessionId}/confirm`, { planHash });
    return parsed(agentCreatedCampaignEnvelopeSchema, response.data, 'Create draft').data;
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * The `{ data: AgentSession }` envelope of `POST /abandon`.
 *
 * Built here rather than imported because `campaign.schema.ts` exports envelopes only for the
 * responses it needed one for (turn, detail, list, created campaign) and this is the fifth. It is
 * composed from the *shared* `agentSessionSchema`, so the field-level contract still has exactly
 * one definition — only the one-line wrapper is local.
 */
const agentSessionEnvelopeSchema = z.object({ data: agentSessionSchema }).strict();

/** `POST /campaign-agent/sessions/:id/abandon` — ends a conversation without creating anything. */
export async function abandonAgentSession(sessionId: string): Promise<AgentSession> {
  try {
    const response = await api.post<unknown>(`${SESSIONS_PATH}/${sessionId}/abandon`, {});
    return parsed(agentSessionEnvelopeSchema, response.data, 'Abandon assistant session').data;
  } catch (error) {
    throw toApiError(error);
  }
}
