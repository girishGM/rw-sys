/**
 * T-048 — the model transport (`llm.provider.ts`), 10-AI-CAMPAIGN-AGENT.md §7 and §8.
 *
 * TC-23 (*"logs during a conversation → no raw prompt content, no PII"*) and TC-24 (*"LLM
 * unavailable → clean error; wizard offered as fallback"*) both live here. TC-23 is asserted by
 * capturing everything the logger is handed and checking that a distinctive PII marker put into
 * the prompt never appears in it — which is a stronger claim than "we call `redactForLog`".
 */
import { Logger } from '@nestjs/common';
import { hashPrompt, OllamaLlmProvider } from '@/modules/campaign-agent/llm.provider';
import { LlmUnavailableError } from '@/modules/campaign-agent/agent.errors';

const CONFIG = {
  get: (key: string) =>
    ({
      AGENT_LLM_BASE_URL: 'http://127.0.0.1:11434',
      AGENT_LLM_MODEL: 'llama3.1:8b',
      AGENT_LLM_TIMEOUT_MS: 1_000,
    })[key],
};

function makeProvider() {
  return new OllamaLlmProvider(CONFIG as never);
}

/** A prompt carrying every kind of thing §7 says must not be logged. */
const SECRET_SYSTEM = 'Budget is 5,000,000 MYR for merchant Acme Holdings Sdn Bhd';
const SECRET_MESSAGE = 'my email is somebody@example.invalid and my card is 4111111111111111';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function stubFetch(implementation: (url: string) => Promise<unknown>) {
  global.fetch = jest.fn(async (url: unknown) =>
    implementation(String(url)),
  ) as unknown as typeof fetch;
}

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('complete — the happy path', () => {
  it('returns the model’s text and the telemetry §7 requires', async () => {
    stubFetch(async () =>
      okResponse({ message: { content: '{"reply":"hi"}' }, prompt_eval_count: 12, eval_count: 3 }),
    );

    const completion = await makeProvider().complete('system', [{ role: 'user', content: 'hi' }]);

    expect(completion.text).toBe('{"reply":"hi"}');
    expect(completion.telemetry.model).toBe('ollama:llama3.1:8b');
    expect(completion.telemetry.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(completion.telemetry.promptTokens).toBe(12);
    expect(completion.telemetry.completionTokens).toBe(3);
    expect(completion.telemetry.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('asks Ollama for constrained JSON at temperature 0, and sends the system prompt first', async () => {
    let sent: Record<string, unknown> = {};
    global.fetch = jest.fn(async (_url: unknown, init: unknown) => {
      sent = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
      return okResponse({ message: { content: '{}' } });
    }) as unknown as typeof fetch;

    await makeProvider().complete('SYSTEM', [{ role: 'user', content: 'hello' }]);

    expect(sent['format']).toBe('json');
    expect(sent['stream']).toBe(false);
    expect(sent['options']).toEqual({ temperature: 0 });
    expect(sent['messages']).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('tolerates a response with no token counts', async () => {
    stubFetch(async () => okResponse({ message: { content: 'x' } }));
    const completion = await makeProvider().complete('s', []);
    expect(completion.telemetry.promptTokens).toBeNull();
    expect(completion.telemetry.completionTokens).toBeNull();
  });

  it('returns empty text rather than undefined when the model says nothing', async () => {
    stubFetch(async () => okResponse({}));
    expect((await makeProvider().complete('s', [])).text).toBe('');
  });
});

describe('logging — §7, TC-23', () => {
  it('logs the model, hash, tokens and latency, and never the prompt', async () => {
    const lines: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      lines.push(String(message));
    });
    stubFetch(async () =>
      okResponse({ message: { content: 'ok' }, prompt_eval_count: 12, eval_count: 3 }),
    );

    await makeProvider().complete(SECRET_SYSTEM, [{ role: 'user', content: SECRET_MESSAGE }]);

    const logged = lines.join('\n');
    expect(logged).toContain('ollama:llama3.1:8b');
    expect(logged).toContain('latencyMs');
    // §7's four fields are actually *recorded*, not masked away. T-014's redaction pattern matches
    // `hash` and `token`, so the log payload renames them — see `llm.provider.ts`'s comment on why
    // that keeps both rules intact rather than weakening either.
    expect(logged).toContain('promptDigest');
    expect(logged).toMatch(/"promptDigest":"[0-9a-f]{64}"/);
    expect(logged).toMatch(/"promptEvalCount":12/);
    expect(logged).toMatch(/"completionEvalCount":3/);

    // The three things §7 names: no raw prompt content, and therefore no PII carried in it.
    expect(logged).not.toContain('Acme Holdings');
    expect(logged).not.toContain('5,000,000');
    expect(logged).not.toContain('somebody@example.invalid');
    expect(logged).not.toContain('4111111111111111');
    expect(logged).not.toContain('ok'.repeat(20)); // nothing resembling the completion body
  });

  it('the unavailable path logs the hash, not the prompt either', async () => {
    const errors: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });

    const error = (await makeProvider()
      .complete(SECRET_SYSTEM, [{ role: 'user', content: SECRET_MESSAGE }])
      .catch((thrown: unknown) => thrown)) as LlmUnavailableError;

    expect(JSON.stringify(error.logContext)).not.toContain('Acme Holdings');
    expect(JSON.stringify(error.logContext)).toContain('promptHash');
    expect(errors.join('\n')).not.toContain('somebody@example.invalid');
  });
});

describe('hashPrompt', () => {
  it('is stable for the same conversation', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }];
    expect(hashPrompt('s', messages)).toBe(hashPrompt('s', messages));
  });

  it('differs when the system prompt differs', () => {
    expect(hashPrompt('a', [])).not.toBe(hashPrompt('b', []));
  });

  it('differs when a message differs', () => {
    expect(hashPrompt('s', [{ role: 'user', content: 'a' }])).not.toBe(
      hashPrompt('s', [{ role: 'user', content: 'b' }]),
    );
  });

  it('does not collide when a message boundary moves', () => {
    // Naive concatenation would make ["ab"] and ["a","b"] hash alike.
    expect(hashPrompt('s', [{ role: 'user', content: 'ab' }])).not.toBe(
      hashPrompt('s', [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ]),
    );
  });

  it('reveals nothing about the content — it is a fixed-length hex digest', () => {
    expect(hashPrompt('secret budget 5000000', [])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('unavailability — §9, TC-24', () => {
  it('turns a connection failure into a 503 with the wizard-fallback code', async () => {
    stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });

    const error = (await makeProvider()
      .complete('s', [])
      .catch((thrown: unknown) => thrown)) as LlmUnavailableError;

    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect(error.status).toBe(503);
    expect(error.code).toBe('AGENT_LLM_UNAVAILABLE');
  });

  it('turns a non-2xx response into the same clean error', async () => {
    stubFetch(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(makeProvider().complete('s', [])).rejects.toThrow(LlmUnavailableError);
  });

  it('turns a non-JSON body into the same clean error rather than a parse crash', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    }));
    await expect(makeProvider().complete('s', [])).rejects.toThrow(LlmUnavailableError);
  });

  it('carries no internal detail into the response — the code is all a client sees', async () => {
    stubFetch(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    });
    const error = (await makeProvider()
      .complete('s', [])
      .catch((thrown: unknown) => thrown)) as LlmUnavailableError;
    expect(error.details).toBeUndefined();
  });
});

describe('isAvailable — the liveness probe', () => {
  it('is true when the model server answers', async () => {
    stubFetch(async (url) => {
      expect(url).toContain('/api/tags');
      return { ok: true, status: 200 };
    });
    expect(await makeProvider().isAvailable()).toBe(true);
  });

  it('is false, never throwing, when it does not', async () => {
    stubFetch(async () => {
      throw new Error('down');
    });
    expect(await makeProvider().isAvailable()).toBe(false);
  });

  it('is false on a non-2xx', async () => {
    stubFetch(async () => ({ ok: false, status: 503 }));
    expect(await makeProvider().isAvailable()).toBe(false);
  });
});

describe('configuration — §8', () => {
  it('defaults to a loopback Ollama, so no campaign data leaves the machine', () => {
    const provider = new OllamaLlmProvider({ get: () => undefined } as never);
    expect(provider.label).toBe('ollama:llama3.1:8b');
  });
});
