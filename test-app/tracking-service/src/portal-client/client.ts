/**
 * T-003 — the only code in this service that ever talks to `portal/back-end` (ARCHITECTURE.md
 * §2). Logs in as a seeded portal account, holds the session cookies in memory, and exposes
 * `getCampaigns()`/`getCampaignJourney(id)` with a 5-minute in-memory cache and a manual
 * `refresh()`. See this task's completion report for exactly which portal account/role and why.
 */
import { CookieJar } from './cookie-jar';
import { PortalAuthError, PortalRequestError, PortalUnreachableError } from './errors';
import {
  toPortalCampaign,
  toPortalCampaignJourney,
  type DataEnvelope,
  type ListEnvelope,
  type RawCampaign,
  type RawJourney,
} from './mapping';
import type { PortalCampaign, PortalCampaignJourney } from './types';

/** ARCHITECTURE.md §3 — "cached in memory, refreshed periodically", 5 minutes per the real gRPC
 * `CampaignConfigService`'s own documented cache-invalidation interval (BACKLOG.md). */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

type FetchLike = typeof fetch;

export interface PortalClientConfig {
  /** e.g. `http://localhost:3001` — no trailing slash required, one is stripped if present. */
  readonly baseUrl: string;
  readonly loginEmail: string;
  readonly loginPassword: string;
  /** Defaults to {@link DEFAULT_CACHE_TTL_MS}. */
  readonly cacheTtlMs?: number;
  /** Injectable for tests; defaults to the global `fetch` (Node 20's built-in `undici`). */
  readonly fetchImpl?: FetchLike;
}

interface CacheEntry<T> {
  readonly data: T;
  readonly fetchedAt: number;
}

interface RequestOptions {
  readonly forceRefresh?: boolean;
}

/** `GET /api/v1/campaigns` — the generic, permission-scoped list, not `/merchant/campaigns` (see
 * this task's completion report's "Deviations from spec" for why). */
const CAMPAIGNS_PATH = '/api/v1/campaigns?pageSize=100';

function journeyPath(campaignId: number): string {
  return `/api/v1/campaigns/${campaignId}/journey`;
}

export class PortalClient {
  private readonly baseUrl: string;
  private readonly loginEmail: string;
  private readonly loginPassword: string;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly cookies = new CookieJar();

  private authenticated = false;
  private loginInFlight: Promise<void> | null = null;

  private campaignsCache: CacheEntry<PortalCampaign[]> | null = null;
  private readonly journeyCache = new Map<number, CacheEntry<PortalCampaignJourney>>();

  constructor(config: PortalClientConfig) {
    if (config.baseUrl.trim().length === 0) {
      throw new Error('PortalClient: baseUrl is required');
    }
    if (config.loginEmail.trim().length === 0 || config.loginPassword.length === 0) {
      throw new Error('PortalClient: loginEmail and loginPassword are required');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.loginEmail = config.loginEmail;
    this.loginPassword = config.loginPassword;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** `POST /auth/login`. Safe to call concurrently — a login already in flight is reused rather
   * than firing a second request (TC-1). */
  async login(): Promise<void> {
    if (this.loginInFlight !== null) return this.loginInFlight;
    const attempt = this.performLogin().finally(() => {
      this.loginInFlight = null;
    });
    this.loginInFlight = attempt;
    return attempt;
  }

  /** `GET /api/v1/campaigns` (TC-2). Cached for {@link PortalClientConfig.cacheTtlMs}; pass
   * `{ forceRefresh: true }` or call {@link refresh} first to bypass the cache. */
  async getCampaigns(options: RequestOptions = {}): Promise<PortalCampaign[]> {
    if (!options.forceRefresh && this.campaignsCache && !this.isExpired(this.campaignsCache)) {
      return this.campaignsCache.data;
    }
    const envelope = await this.requestJson<ListEnvelope<RawCampaign>>(CAMPAIGNS_PATH);
    const campaigns = envelope.data.map(toPortalCampaign);
    this.campaignsCache = { data: campaigns, fetchedAt: Date.now() };
    return campaigns;
  }

  /** `GET /api/v1/campaigns/:id/journey` (TC-3). Same caching contract as {@link getCampaigns},
   * keyed per campaign id. */
  async getCampaignJourney(
    campaignId: number,
    options: RequestOptions = {},
  ): Promise<PortalCampaignJourney> {
    const cached = this.journeyCache.get(campaignId);
    if (!options.forceRefresh && cached && !this.isExpired(cached)) {
      return cached.data;
    }
    const envelope = await this.requestJson<DataEnvelope<RawJourney>>(journeyPath(campaignId));
    const journey = toPortalCampaignJourney(envelope.data);
    this.journeyCache.set(campaignId, { data: journey, fetchedAt: Date.now() });
    return journey;
  }

  /** Manual refresh (ARCHITECTURE.md §3): drops every cached entry so the next call re-fetches,
   * without waiting for the TTL to lapse. */
  refresh(): void {
    this.campaignsCache = null;
    this.journeyCache.clear();
  }

  private isExpired(entry: CacheEntry<unknown>): boolean {
    return Date.now() - entry.fetchedAt > this.cacheTtlMs;
  }

  private async performLogin(): Promise<void> {
    const response = await this.safeFetch(`${this.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.loginEmail, password: this.loginPassword }),
    });
    if (!response.ok) {
      this.authenticated = false;
      throw new PortalAuthError(response.status, await readBody(response));
    }
    this.cookies.clear();
    this.cookies.applySetCookie(response.headers.getSetCookie());
    this.authenticated = true;
  }

  /**
   * Every authenticated `GET`. Logs in first if no session has been established yet, and
   * re-authenticates exactly once and retries on a 401 — "session expired" (TC-5) — rather than
   * surfacing the raw 401 to the caller. A second consecutive 401 (e.g. the account itself was
   * disabled) is a real, loud failure, not retried again.
   */
  private async requestJson<T>(path: string): Promise<T> {
    if (!this.authenticated) {
      await this.login();
    }

    let response = await this.authorizedGet(path);
    if (response.status === 401) {
      await this.login();
      response = await this.authorizedGet(path);
    }

    if (!response.ok) {
      throw new PortalRequestError(path, response.status, await readBody(response));
    }
    return (await response.json()) as T;
  }

  private async authorizedGet(path: string): Promise<Response> {
    return this.safeFetch(`${this.baseUrl}${path}`, {
      headers: { Cookie: this.cookies.toHeader() },
    });
  }

  /** Wraps `fetch` so every network-level failure (DNS, connection refused, timeout — the portal
   * being down) becomes a {@link PortalUnreachableError} rather than an unhandled/opaque
   * rejection (TC-10). */
  private async safeFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (cause) {
      this.authenticated = false;
      throw new PortalUnreachableError(this.baseUrl, cause);
    }
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}
