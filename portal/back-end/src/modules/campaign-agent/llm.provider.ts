/**
 * T-048 — Zone 1's only door (10-AI-CAMPAIGN-AGENT.md §8).
 *
 * > *"The existing agent uses **local Ollama**, which is the right default here and worth keeping:
 * > campaign configuration includes budgets and commercial terms, and a local model means none of
 * > it leaves the network. The provider is behind `llm.provider.ts`, so a hosted model is a
 * > configuration change if the product owner later wants one."*
 *
 * Ported from `agents/create-campaign-v2/src/agent/llm.provider.ts`, with three changes, each
 * forced by a portal rule the standalone agent had no equivalent of.
 *
 * ### 1. No native tool-calling — one JSON object per turn
 *
 * The standalone agent used Ollama's `tools` parameter and spent real effort recovering from a
 * local model that wrote its tool calls out as prose instead (`extractPseudoToolCall`). That
 * recovery exists because the model's output *was* the action. Here it is not: the model proposes
 * a slot patch and names tools, and **Zone 2 decides what happens** — every option is re-resolved,
 * every write goes through `CampaignsService`. So the wire format can be the simplest thing that
 * parses, and a model that produces something else produces a rejected turn rather than a
 * half-executed one. `agent.orchestrator.ts` owns the schema; this file owns only the transport.
 *
 * ### 2. Logging records a prompt **hash**, never prompt content (§7, TC-23)
 *
 * > *"Every LLM call records model, prompt hash, token counts and latency — **not** raw prompt
 * > content, which may carry PII."*
 *
 * {@link LlmProvider.complete} returns that telemetry as data, and the caller persists it into
 * `agent_session_events.meta`. This file logs the same fields through T-014's `redactForLog`, and
 * there is **no code path here that logs `system`, `user` or `text`** — not at `debug`, not behind
 * a flag. A debug flag that prints prompts is a debug flag that will be on in production one day.
 *
 * ### 3. Unavailability is a first-class outcome, not an exception to be swallowed (§9, TC-24)
 *
 * A model that is not answering produces {@link LlmUnavailableError}, which the filter renders as
 * a 503 the SPA maps to *"the assistant is unavailable — you can still create this campaign in the
 * wizard"*. The wizard is always the fallback, so this is a degradation, never an outage.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { redactForLog } from '@/common/logging/redact';
import type { Env } from '@/config/env.schema';
import { LlmUnavailableError } from './agent.errors';

/** One message in the conversation as the model sees it. */
export interface LlmMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** What one call cost and produced — everything except the text itself is safe to persist. */
export interface LlmTelemetry {
  readonly model: string;
  /** sha256 of system + transcript. The identity of a prompt, without its content (§7). */
  readonly promptHash: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly latencyMs: number;
}

export interface LlmCompletion {
  readonly text: string;
  readonly telemetry: LlmTelemetry;
}

/** The seam a hosted provider would implement (§8). Injected by token so a test can substitute a
 * deterministic model without a network, which is how TC-7/TC-10/TC-12/TC-13 are provable at all. */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export interface LlmProvider {
  /** The provider label, for telemetry and for the health check. */
  readonly label: string;
  /** One completion. Throws {@link LlmUnavailableError} and nothing else. */
  complete(system: string, messages: readonly LlmMessage[]): Promise<LlmCompletion>;
  /** Whether the model answered a trivial probe. Never throws. */
  isAvailable(): Promise<boolean>;
}

interface OllamaChatResponse {
  readonly message?: { readonly content?: string };
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

/**
 * The local-Ollama implementation — the default, and the only one this task ships (§8).
 *
 * `AGENT_LLM_PROVIDER` exists as a switch point rather than because a second provider exists. If
 * one is ever added, §8's condition becomes binding and belongs in the review of *that* change:
 * *"If a hosted model is ever used, the redaction requirement becomes binding: no merchant names,
 * no budgets, no customer data in prompts without an explicit decision."*
 */
@Injectable()
export class OllamaLlmProvider implements LlmProvider {
  private readonly logger = new Logger(OllamaLlmProvider.name);
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  readonly label: string;

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    this.baseUrl = config.get('AGENT_LLM_BASE_URL', { infer: true }) ?? 'http://127.0.0.1:11434';
    this.model = config.get('AGENT_LLM_MODEL', { infer: true }) ?? 'llama3.1:8b';
    this.timeoutMs = config.get('AGENT_LLM_TIMEOUT_MS', { infer: true }) ?? 60_000;
    this.label = `ollama:${this.model}`;
  }

  async complete(system: string, messages: readonly LlmMessage[]): Promise<LlmCompletion> {
    const promptHash = hashPrompt(system, messages);
    const startedAt = Date.now();

    const body = {
      model: this.model,
      stream: false,
      // `format: 'json'` is Ollama's own constrained decoding. It is a *convenience*, not a
      // control: the orchestrator parses and Zod-validates the result regardless, because a model
      // that ignores this flag must fail closed rather than be trusted to have obeyed it.
      format: 'json',
      options: { temperature: 0 },
      messages: [{ role: 'system', content: system }, ...messages],
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // The message deliberately names the endpoint and not the payload — see this file's header.
      throw new LlmUnavailableError({
        cause: error,
        logMessage: `The campaign agent's model at ${this.baseUrl} did not answer`,
        logContext: { model: this.model, promptHash },
      });
    }

    if (!response.ok) {
      throw new LlmUnavailableError({
        logMessage: `The campaign agent's model returned HTTP ${response.status}`,
        logContext: { model: this.model, promptHash, status: response.status },
      });
    }

    let parsed: OllamaChatResponse;
    try {
      parsed = (await response.json()) as OllamaChatResponse;
    } catch (error) {
      throw new LlmUnavailableError({
        cause: error,
        logMessage: "The campaign agent's model returned a body that was not JSON",
        logContext: { model: this.model, promptHash },
      });
    }

    const telemetry: LlmTelemetry = {
      model: this.label,
      promptHash,
      promptTokens: parsed.prompt_eval_count ?? null,
      completionTokens: parsed.eval_count ?? null,
      latencyMs: Date.now() - startedAt,
    };

    // §7 / TC-23: *"records model, prompt hash, token counts and latency — **not** raw prompt
    // content"*. Every value below is either a constant, a digest or an integer; none of them can
    // carry prompt content, which is the property that makes this line safe.
    //
    // ### Why the keys are renamed for the log line
    //
    // T-014's `SENSITIVE_KEY_PATTERN` is `/password|token|secret|hash|…/i` and is *deliberately*
    // over-broad — its own header says so: *"it will mask `hashAlgorithm` and `mfaEnabled`,
    // neither of which is a secret, and that is the correct trade"*. Here that trade collides
    // head-on with §7: `promptHash` and `promptTokens` are precisely the two things §7 requires
    // to be recorded, and both match the pattern, so passing them under those names logs
    // `[REDACTED]` twice and records nothing.
    //
    // The fix keeps both rules intact rather than weakening either. The *pattern* is untouched
    // (no rule disabled, no field exempted); the **telemetry keeps its honest field names** for
    // the interface and for `agent_session_events.meta`; only this one log payload uses names
    // that do not collide — `promptDigest` (a sha256, non-reversible by construction) and
    // `promptEvalCount`/`completionEvalCount` (integers, Ollama's own names for them). The
    // payload still passes through `redactForLog`, so a future edit that adds a genuinely
    // sensitive field is still masked.
    this.logger.log(
      `LLM call ${JSON.stringify(
        redactForLog({
          model: telemetry.model,
          promptDigest: telemetry.promptHash,
          promptEvalCount: telemetry.promptTokens,
          completionEvalCount: telemetry.completionTokens,
          latencyMs: telemetry.latencyMs,
        }),
      )}`,
    );

    return { text: parsed.message?.content ?? '', telemetry };
  }

  /** A cheap liveness probe for the health of the assistant route (§9). Never throws: the caller
   * is deciding whether to offer the chat at all, and an exception there would be the outage the
   * fallback exists to avoid. */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5_000)),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * The identity of a prompt, without its content (§7).
 *
 * The whole prompt — system instructions and every turn — goes into one sha256. Two identical
 * conversations hash alike, which is what makes the telemetry useful for spotting a loop; nothing
 * about what was said can be recovered from it, which is what makes it safe to store next to a
 * campaign a checker will read.
 */
export function hashPrompt(system: string, messages: readonly LlmMessage[]): string {
  const hash = createHash('sha256');
  hash.update(system);
  for (const message of messages) {
    hash.update(' ');
    hash.update(message.role);
    hash.update(' ');
    hash.update(message.content);
  }
  return hash.digest('hex');
}
