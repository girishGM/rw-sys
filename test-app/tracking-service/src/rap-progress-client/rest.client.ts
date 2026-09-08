/**
 * T-INT-021 — calls RAP's real, RAP-owned `ProgressController` REST routes (T-RAP-040):
 * `GET /progress/customers/:customerId/campaigns/:campaignCode` and
 * `.../trackers/:trackerCode`, guarded by `ProgressApiAuthGuard`. Pure transport plumbing only,
 * mirroring the split `reward-tracking-client/rest.client.ts` already established: this class does
 * the call and throws typed errors (`errors.ts`) on failure; it is `client.ts`'s/the route's job to
 * catch those and select a fallback or degrade gracefully.
 */
import { RapProgressRequestError, RapProgressUnreachableError } from './errors';
import { signProgressApiToken } from './token';
import type {
  GetCampaignProgressParams,
  GetTrackerProgressParams,
  RapCampaignProgress,
  RapProgressReader,
  RapTrackerProgress,
} from './types';

type FetchLike = typeof fetch;

/** Short-lived on purpose, same reasoning `reward-tracking-client/rest.client.ts`'s own
 * `DEFAULT_TOKEN_TTL_SECONDS` documents: this app mints a fresh token per request rather than
 * caching one. */
const DEFAULT_TOKEN_TTL_SECONDS = 300;

interface CampaignProgressWire {
  readonly customerId: string;
  readonly campaignCode: string;
  readonly trackers: readonly TrackerProgressWire[];
}

interface TrackerProgressWire {
  readonly trackerCode: string;
  readonly completionLogic: string | null;
  readonly isCompleted: boolean;
  readonly completedAt: string | null;
  readonly componentsRequiredCount: number;
  readonly componentsCompletedCount: number;
  readonly components: readonly {
    readonly componentCode: string;
    readonly currentCount: number;
    readonly requiredCount: number;
    readonly isCompleted: boolean;
  }[];
}

/** RAP's own `TrackerProgressResponse = TrackerProgressView & { customerId, campaignCode }` — the
 * single-tracker route's own response shape (T-RAP-040's `progress.types.ts`). */
type TrackerProgressResponseWire = TrackerProgressWire & {
  readonly customerId: string;
  readonly campaignCode: string;
};

export interface RapProgressRestClientConfig {
  /** e.g. `http://localhost:3021` — RAP's own `PROGRESS_API_PORT` default. No trailing slash
   * required, one is stripped if present. */
  readonly baseUrl: string;
  readonly secret: Buffer;
  readonly timeoutMs: number;
  readonly tokenTtlSeconds?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
}

export class RapProgressRestClient implements RapProgressReader {
  private readonly baseUrl: string;
  private readonly secret: Buffer;
  private readonly timeoutMs: number;
  private readonly tokenTtlSeconds: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(config: RapProgressRestClientConfig) {
    if (config.baseUrl.trim().length === 0) {
      throw new Error('RapProgressRestClient: baseUrl is required');
    }
    if (config.secret.length === 0) {
      throw new Error('RapProgressRestClient: secret is required');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.secret = config.secret;
    this.timeoutMs = config.timeoutMs;
    this.tokenTtlSeconds = config.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  async getCampaignProgress(params: GetCampaignProgressParams): Promise<RapCampaignProgress> {
    const path = `/progress/customers/${encodeURIComponent(params.customerId)}/campaigns/${encodeURIComponent(params.campaignCode)}`;
    const wire = await this.request<CampaignProgressWire>(path, params.tenantId, params.customerId);
    return {
      customerId: wire.customerId,
      campaignCode: wire.campaignCode,
      trackers: wire.trackers.map(toTrackerProgress),
    };
  }

  async getTrackerProgress(params: GetTrackerProgressParams): Promise<RapTrackerProgress> {
    const path =
      `/progress/customers/${encodeURIComponent(params.customerId)}/campaigns/` +
      `${encodeURIComponent(params.campaignCode)}/trackers/${encodeURIComponent(params.trackerCode)}`;
    const wire = await this.request<TrackerProgressResponseWire>(
      path,
      params.tenantId,
      params.customerId,
    );
    return toTrackerProgress(wire);
  }

  private async request<T>(path: string, tenantId: number, customerId: string): Promise<T> {
    const token = signProgressApiToken(
      { tenantId, customerId, exp: Math.floor(this.now().getTime() / 1000) + this.tokenTtlSeconds },
      this.secret,
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (cause) {
      throw new RapProgressUnreachableError('REST', this.baseUrl, cause);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new RapProgressRequestError('REST', response.status, await readBody(response));
    }
    return (await response.json()) as T;
  }
}

function toTrackerProgress(wire: TrackerProgressWire): RapTrackerProgress {
  return {
    trackerCode: wire.trackerCode,
    completionLogic: wire.completionLogic,
    isCompleted: wire.isCompleted,
    completedAt: wire.completedAt,
    componentsRequiredCount: wire.componentsRequiredCount,
    componentsCompletedCount: wire.componentsCompletedCount,
    components: wire.components.map((component) => ({
      componentCode: component.componentCode,
      currentCount: component.currentCount,
      requiredCount: component.requiredCount,
      isCompleted: component.isCompleted,
    })),
  };
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}
