/**
 * T-049 — `useAgentSession`'s own edges: the failure classifier, the sentence a chip selection
 * sends, and the guards that keep exactly one turn in flight.
 *
 * `AgentChatPage.spec.tsx` covers the hook through the screen, which is how it is used. This file
 * covers the branches a screen cannot reach on purpose — a `busy` hook asked to send again, a
 * rejection that is not an `ApiError` at all — because those are the ones that misbehave quietly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const { mockAbandon, mockBuildPlan, mockConfirm, mockList, mockResume, mockSend, mockStart } =
  vi.hoisted(() => ({
    mockAbandon: vi.fn(),
    mockBuildPlan: vi.fn(),
    mockConfirm: vi.fn(),
    mockList: vi.fn(),
    mockResume: vi.fn(),
    mockSend: vi.fn(),
    mockStart: vi.fn(),
  }));

vi.mock('../../../src/features/campaign-agent/api', () => ({
  AGENT_TIMEOUT_CODE: 'AGENT_TURN_TIMEOUT',
  AGENT_TURN_TIMEOUT_MS: 30_000,
  abandonAgentSession: mockAbandon,
  buildAgentPlan: mockBuildPlan,
  confirmAgentPlan: mockConfirm,
  listAgentSessions: mockList,
  resumeAgentSession: mockResume,
  sendAgentMessage: mockSend,
  startAgentSession: mockStart,
}));

import {
  classifyFailure,
  selectionMessage,
  useAgentSession,
} from '../../../src/features/campaign-agent/useAgentSession';
import { ApiError } from '../../../src/lib/apiError';
import { SESSION_ID, session, turn } from './fixtures';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  for (const mock of [
    mockAbandon,
    mockBuildPlan,
    mockConfirm,
    mockList,
    mockResume,
    mockSend,
    mockStart,
  ]) {
    mock.mockReset();
  }
  mockList.mockResolvedValue([]);
  mockStart.mockResolvedValue(turn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyFailure', () => {
  it('a 503 is the model being unavailable, whatever code it carries', () => {
    expect(
      classifyFailure(new ApiError({ code: 'SERVICE_UNAVAILABLE', message: 'down', status: 503 }))
        .kind,
    ).toBe('unavailable');
    expect(
      classifyFailure(new ApiError({ code: 'AGENT_LLM_UNAVAILABLE', message: 'down', status: 200 }))
        .kind,
    ).toBe('unavailable');
  });

  it('the client-side stall code is a timeout, and is retryable', () => {
    const failure = classifyFailure(
      new ApiError({ code: 'AGENT_TURN_TIMEOUT', message: 'no answer', status: 0 }),
    );
    expect(failure).toMatchObject({ kind: 'timeout', retryable: true });
  });

  it('a request that never reached the server is a network failure', () => {
    expect(
      classifyFailure(new ApiError({ code: 'NETWORK_ERROR', message: 'offline', status: 0 })).kind,
    ).toBe('network');
  });

  it('a policy refusal keeps its codes and is not offered as a retry', () => {
    const failure = classifyFailure(
      new ApiError({
        code: 'AGENT_POLICY_VIOLATION',
        message: 'above the ceiling',
        status: 422,
        details: [{ field: 'plan', code: 'BUDGET_ABOVE_TENANT_CEILING' }],
      }),
    );
    expect(failure).toMatchObject({
      kind: 'policy',
      retryable: false,
      codes: ['BUDGET_ABOVE_TENANT_CEILING'],
    });
  });

  it('an incomplete plan is the same class of refusal', () => {
    expect(
      classifyFailure(
        new ApiError({ code: 'AGENT_PLAN_INCOMPLETE', message: 'not finished', status: 422 }),
      ).kind,
    ).toBe('policy');
  });

  it('anything else is "other", including a thrown value that is not an ApiError', () => {
    expect(
      classifyFailure(new ApiError({ code: 'CONFLICT', message: 'changed', status: 409 })).kind,
    ).toBe('other');
    expect(classifyFailure(new Error('boom'))).toMatchObject({ kind: 'other', message: 'boom' });
    expect(classifyFailure('a string')).toMatchObject({
      kind: 'other',
      message: 'Something went wrong. Please try again.',
    });
  });
});

describe('selectionMessage', () => {
  it('carries every chosen option’s label, subtitle and optionId', () => {
    expect(
      selectionMessage('merchants', [
        { optionId: 'm_1', label: 'Acme', subtitle: 'ACME' },
        { optionId: 'm_2', label: 'TechWorld', subtitle: 'TW' },
      ]),
    ).toBe('I choose these merchants: Acme — ACME (m_1), TechWorld — TW (m_2)');
  });

  it('omits an empty subtitle rather than rendering a dangling dash', () => {
    expect(
      selectionMessage('rewards', [{ optionId: 'rw_9', label: 'Cashback', subtitle: null }]),
    ).toBe('I choose this reward: Cashback (rw_9)');
    expect(
      selectionMessage('activities', [{ optionId: 'a_1', label: 'Purchase', subtitle: '' }]),
    ).toBe('I choose these activities: Purchase (a_1)');
  });
});

describe('the one-turn-in-flight guards', () => {
  it('ignores an empty or whitespace-only message', async () => {
    const { result } = renderHook(() => useAgentSession(), { wrapper });
    await waitFor(() => {
      expect(result.current.starting).toBe(false);
    });

    act(() => {
      result.current.send('   ');
    });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('ignores a second send while the first turn is still in flight', async () => {
    mockSend.mockImplementation(() => new Promise(() => undefined));
    const { result } = renderHook(() => useAgentSession(), { wrapper });
    await waitFor(() => {
      expect(result.current.starting).toBe(false);
    });

    act(() => {
      result.current.send('first');
    });
    await waitFor(() => {
      expect(result.current.busy).toBe(true);
    });
    act(() => {
      result.current.send('second');
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(SESSION_ID, 'first');
  });

  it('ignores an empty chip selection', async () => {
    const { result } = renderHook(() => useAgentSession(), { wrapper });
    await waitFor(() => {
      expect(result.current.starting).toBe(false);
    });

    act(() => {
      result.current.choose('merchants', []);
    });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses to confirm a session that has no plan hash — there is nothing to confirm', async () => {
    const { result } = renderHook(() => useAgentSession(), { wrapper });
    await waitFor(() => {
      expect(result.current.starting).toBe(false);
    });

    act(() => {
      result.current.confirmPlan();
    });

    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

describe('recovery paths', () => {
  it('re-bootstraps when retry is pressed before a session ever opened', async () => {
    mockList.mockRejectedValueOnce(
      new ApiError({ code: 'NETWORK_ERROR', message: 'offline', status: 0 }),
    );
    const { result } = renderHook(() => useAgentSession(), { wrapper });
    await waitFor(() => {
      expect(result.current.failure?.kind).toBe('network');
    });
    expect(result.current.session).toBeNull();

    mockList.mockResolvedValue([]);
    act(() => {
      result.current.retry();
    });

    await waitFor(() => {
      expect(result.current.session).not.toBeNull();
    });
    expect(mockStart).toHaveBeenCalled();
  });

  it('surfaces a failure to abandon rather than pretending the conversation restarted', async () => {
    mockList.mockResolvedValue([session()]);
    mockResume.mockResolvedValue({
      session: session(),
      events: [],
      options: { merchants: [], activities: [], rules: [], rewards: [] },
      progress: { missing: [], nextStep: 'x', complete: false, offerWizard: false },
      plan: null,
    });
    mockAbandon.mockRejectedValue(
      new ApiError({ code: 'AGENT_SESSION_NOT_ACTIVE', message: 'already ended', status: 409 }),
    );
    const { result } = renderHook(() => useAgentSession(), { wrapper });
    await waitFor(() => {
      expect(result.current.starting).toBe(false);
    });

    act(() => {
      result.current.restart();
    });

    await waitFor(() => {
      expect(result.current.failure?.message).toBe('already ended');
    });
    expect(mockStart).not.toHaveBeenCalled();
  });
});
