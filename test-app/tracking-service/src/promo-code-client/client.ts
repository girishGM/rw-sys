/**
 * Calls `promo-code-service`'s REST generation endpoint directly
 * (`POST /api/v1/promo-codes/generate`, T-PC-056) — this app *is* the "real generation caller"
 * that endpoint's `GENERATION_SERVICE_TOKEN` guard exists for
 * (`promo-code-service/CLAUDE.md`: "only a real generation caller should ever hold this one —
 * never give it to the portal"). Deliberately not `PortalClient`-shaped: no login/session, no
 * cache — one bearer-token-guarded POST per completed tracker.
 */
import { PromoCodeServiceRequestError, PromoCodeServiceUnreachableError } from './errors';
import type { GenerateCodeRequest, GenerateCodeResult } from './types';

type FetchLike = typeof fetch;

const GENERATE_PATH = '/api/v1/promo-codes/generate';

export interface PromoCodeClientConfig {
  /** e.g. `http://localhost:3010` — no trailing slash required, one is stripped if present. */
  readonly baseUrl: string;
  readonly generationToken: string;
  /** Injectable for tests; defaults to the global `fetch` (Node 20's built-in `undici`). */
  readonly fetchImpl?: FetchLike;
}

export class PromoCodeClient {
  private readonly baseUrl: string;
  private readonly generationToken: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: PromoCodeClientConfig) {
    if (config.baseUrl.trim().length === 0) {
      throw new Error('PromoCodeClient: baseUrl is required');
    }
    if (config.generationToken.trim().length === 0) {
      throw new Error('PromoCodeClient: generationToken is required');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.generationToken = config.generationToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async generateCode(request: GenerateCodeRequest): Promise<GenerateCodeResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${GENERATE_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.generationToken}`,
        },
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw new PromoCodeServiceUnreachableError(this.baseUrl, cause);
    }

    // The endpoint's own contract: always 200 for a business outcome (`status` inside the body
    // carries SUCCESS/FAILED); a real HTTP error status means the request itself was refused
    // before ever reaching PromoCodeGenerationService (401 guard, 400 malformed body, 500).
    if (!response.ok) {
      throw new PromoCodeServiceRequestError(response.status, await readBody(response));
    }
    return (await response.json()) as GenerateCodeResult;
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}
