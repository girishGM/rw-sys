/**
 * T-049 — `features/campaign-agent/api.ts`: the wire calls, the contract parse and the 30-second
 * stall bound (implementation note 6, TC-11).
 *
 * The `api` singleton is mocked the same way `test/features/auth/api.spec.ts` (T-024) mocks it, so
 * these tests exercise this module's own logic — paths, bodies, schema parsing, the abort timer —
 * without a live interceptor chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('../../../src/lib/apiClient', () => ({ api: { get: mockGet, post: mockPost } }));

import {
  AGENT_TIMEOUT_CODE,
  AGENT_TURN_TIMEOUT_MS,
  abandonAgentSession,
  buildAgentPlan,
  confirmAgentPlan,
  listAgentSessions,
  resumeAgentSession,
  sendAgentMessage,
  startAgentSession,
} from '../../../src/features/campaign-agent/api';
import { ApiError } from '../../../src/lib/apiError';
import { SESSION_ID, created, detail, session, turn } from './fixtures';

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the session calls', () => {
  it('POST /campaign-agent/sessions opens a conversation and parses the turn', async () => {
    mockPost.mockResolvedValue({ data: { data: turn() } });

    const result = await startAgentSession();

    expect(mockPost).toHaveBeenCalledWith('/campaign-agent/sessions', {});
    expect(result.reply).toBe('Which merchants should take part?');
  });

  it('GET /campaign-agent/sessions lists the maker’s own sessions', async () => {
    mockGet.mockResolvedValue({ data: { data: [session()] } });

    const result = await listAgentSessions();

    expect(mockGet).toHaveBeenCalledWith('/campaign-agent/sessions');
    expect(result).toHaveLength(1);
  });

  it('GET /campaign-agent/sessions/:id resumes with the transcript', async () => {
    mockGet.mockResolvedValue({ data: { data: detail() } });

    const result = await resumeAgentSession(SESSION_ID);

    expect(mockGet).toHaveBeenCalledWith(`/campaign-agent/sessions/${SESSION_ID}`);
    expect(result.events).toHaveLength(2);
  });

  it('POST /abandon parses the session envelope', async () => {
    mockPost.mockResolvedValue({ data: { data: session({ state: 'abandoned' }) } });

    const result = await abandonAgentSession(SESSION_ID);

    expect(mockPost).toHaveBeenCalledWith(`/campaign-agent/sessions/${SESSION_ID}/abandon`, {});
    expect(result.state).toBe('abandoned');
  });

  it('rejects when the response shape drifts, keeping the detail on the cause', async () => {
    // The same shape `campaigns/api.ts` produces: the caller gets an `ApiError` it can render, and
    // the contract message — which names the offending field and is meaningless to a maker — stays
    // on `cause` for the console rather than in a chat bubble.
    mockPost.mockResolvedValue({ data: { data: { reply: 'hi' } } });

    const error = await startAgentSession().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('UNKNOWN_ERROR');
    expect(String((error as { cause?: unknown }).cause)).toMatch(
      /did not match the expected shape/,
    );
  });
});

describe('sending a message', () => {
  it('posts only the message text and passes an abort signal', async () => {
    mockPost.mockResolvedValue({ data: { data: turn() } });

    await sendAgentMessage(SESSION_ID, 'A weekend cashback campaign');

    const [url, body, config] = mockPost.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { signal?: AbortSignal },
    ];
    expect(url).toBe(`/campaign-agent/sessions/${SESSION_ID}/messages`);
    // R3 — no tenant, no user, no scope. The message and nothing else.
    expect(Object.keys(body)).toEqual(['message']);
    expect(config.signal).toBeInstanceOf(AbortSignal);
  });

  it('TC-11 — a stalled turn aborts at 30 s and rejects with the timeout code', async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    mockPost.mockImplementation(
      (_url: string, _body: unknown, config: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          capturedSignal = config.signal;
          config.signal.addEventListener('abort', () => {
            reject(new Error('canceled'));
          });
        }),
    );

    const pending = sendAgentMessage(SESSION_ID, 'hello');
    const assertion = expect(pending).rejects.toMatchObject({
      code: AGENT_TIMEOUT_CODE,
      status: 0,
    });

    await vi.advanceTimersByTimeAsync(AGENT_TURN_TIMEOUT_MS);

    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('a failure that is not the timeout keeps the server’s own code', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 503,
        data: {
          error: { code: 'AGENT_LLM_UNAVAILABLE', message: 'The assistant is unavailable.' },
        },
      },
    });

    await expect(sendAgentMessage(SESSION_ID, 'hello')).rejects.toMatchObject({
      code: 'AGENT_LLM_UNAVAILABLE',
      status: 503,
    });
  });
});

describe('the plan and the confirmation', () => {
  it('POST /plan builds the plan under the same stall bound', async () => {
    mockPost.mockResolvedValue({ data: { data: turn({ plan: null }) } });

    await buildAgentPlan(SESSION_ID);

    const [url, body, config] = mockPost.mock.calls[0] as [
      string,
      unknown,
      { signal?: AbortSignal },
    ];
    expect(url).toBe(`/campaign-agent/sessions/${SESSION_ID}/plan`);
    expect(body).toEqual({});
    expect(config.signal).toBeInstanceOf(AbortSignal);
  });

  it('POST /confirm sends the plan hash and nothing else (10-AI §3.2)', async () => {
    mockPost.mockResolvedValue({ data: { data: created() } });
    const hash = 'a'.repeat(64);

    const result = await confirmAgentPlan(SESSION_ID, hash);

    const [url, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(`/campaign-agent/sessions/${SESSION_ID}/confirm`);
    expect(body).toEqual({ planHash: hash });
    expect(result.campaign.campaignCode).toBe('RAYA-2026');
    expect(result.handOff.wizardPath).toBe('/campaigns/42');
  });

  it('maps a plan-hash conflict into an ApiError carrying the server code', async () => {
    mockPost.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: { error: { code: 'AGENT_PLAN_HASH_MISMATCH', message: 'The plan changed.' } },
      },
    });

    const error = await confirmAgentPlan(SESSION_ID, 'a'.repeat(64)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('AGENT_PLAN_HASH_MISMATCH');
  });
});
