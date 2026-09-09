/**
 * T-INT-013 — `PortalConfigRestClient` + `loadPortalConfigRestClientOptions`, unit-tested against
 * an injected fake `fetch` (the same "`fetchImpl` is injectable for tests" convention
 * `test-app/tracking-service/src/portal-client/client.ts`'s own `PortalClientConfig` already
 * uses) — no real network, no real portal process. The real wire-level round trip against a real
 * booted portal back-end (T-INT-010's own REST mirror) is exercised by
 * `campaign-hierarchy.client.spec.ts`'s own fallback-path tests plus this task's own manual
 * verification steps (see the completion report).
 */
import 'reflect-metadata';
import {
  DEFAULT_PORTAL_REST_BASE_URL,
  DEFAULT_PORTAL_REST_TIMEOUT_MS,
  PortalConfigRestClient,
  PortalConfigRestError,
  loadPortalConfigRestClientOptions,
} from '@/modules/campaign-cache/portal-config-rest.client';
import type { ConfigSectionName } from '@/modules/campaign-cache/campaign-hierarchy.client';

const SECTIONS: readonly ConfigSectionName[] = ['BASIC', 'MERCHANTS', 'TRACKERS'];

// =================================================================================================
// Part 1 — pure env-parsing unit tests (`loadPortalConfigRestClientOptions`).
// =================================================================================================

const ENV_KEYS = [
  'PORTAL_REST_BASE_URL',
  'PORTAL_REST_TIMEOUT_MS',
  'PORTAL_CAMPAIGN_CONFIG_API_TOKEN',
  'PORTAL_SERVICE_IDENTITY',
] as const;

describe('loadPortalConfigRestClientOptions', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('throws when PORTAL_CAMPAIGN_CONFIG_API_TOKEN is unset', () => {
    process.env.PORTAL_SERVICE_IDENTITY = 'rts.internal';
    expect(() => loadPortalConfigRestClientOptions()).toThrow(
      /PORTAL_CAMPAIGN_CONFIG_API_TOKEN is required/,
    );
  });

  it('throws when PORTAL_SERVICE_IDENTITY is unset', () => {
    process.env.PORTAL_CAMPAIGN_CONFIG_API_TOKEN = 'tok';
    expect(() => loadPortalConfigRestClientOptions()).toThrow(
      /PORTAL_SERVICE_IDENTITY is required/,
    );
  });

  it('defaults base URL/timeout when unset, and strips a trailing slash', () => {
    process.env.PORTAL_CAMPAIGN_CONFIG_API_TOKEN = 'tok';
    process.env.PORTAL_SERVICE_IDENTITY = 'rts.internal';
    process.env.PORTAL_REST_BASE_URL = 'http://localhost:3001/';

    const options = loadPortalConfigRestClientOptions();

    expect(options.baseUrl).toBe('http://localhost:3001');
    expect(options.timeoutMs).toBe(DEFAULT_PORTAL_REST_TIMEOUT_MS);
    expect(options.token).toBe('tok');
    expect(options.serviceIdentity).toBe('rts.internal');
  });

  it('uses DEFAULT_PORTAL_REST_BASE_URL when PORTAL_REST_BASE_URL is unset', () => {
    process.env.PORTAL_CAMPAIGN_CONFIG_API_TOKEN = 'tok';
    process.env.PORTAL_SERVICE_IDENTITY = 'rts.internal';

    expect(loadPortalConfigRestClientOptions().baseUrl).toBe(DEFAULT_PORTAL_REST_BASE_URL);
  });

  it('rejects a zero/negative PORTAL_REST_TIMEOUT_MS', () => {
    process.env.PORTAL_CAMPAIGN_CONFIG_API_TOKEN = 'tok';
    process.env.PORTAL_SERVICE_IDENTITY = 'rts.internal';
    process.env.PORTAL_REST_TIMEOUT_MS = '0';

    expect(() => loadPortalConfigRestClientOptions()).toThrow(/PORTAL_REST_TIMEOUT_MS/);
  });
});

// =================================================================================================
// Part 2 — `PortalConfigRestClient`, against an injected fake `fetch`.
// =================================================================================================

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function buildClient(fetchImpl: typeof fetch): PortalConfigRestClient {
  return new PortalConfigRestClient({
    baseUrl: 'http://portal.test',
    token: 'tok-123',
    serviceIdentity: 'rts.internal',
    timeoutMs: 2_000,
    fetchImpl,
  });
}

describe('PortalConfigRestClient', () => {
  it('listActiveCampaigns: GETs the right path, headers, and unwraps the {data} envelope', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse(200, {
        data: { campaigns: [], servedAt: 's', sectionsReturned: [], sectionsOmitted: [] },
      });
    };
    const client = buildClient(fakeFetch);

    const result = await client.listActiveCampaigns(42, SECTIONS);

    expect(result).toEqual({
      campaigns: [],
      servedAt: 's',
      sectionsReturned: [],
      sectionsOmitted: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'http://portal.test/api/v1/campaign-config/tenants/42/campaigns?sections=BASIC,MERCHANTS,TRACKERS',
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(headers['X-Service-Identity']).toBe('rts.internal');
  });

  it('getCampaignConfig: GETs the campaign-scoped path with etag as both a query param and If-None-Match', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse(200, {
        data: {
          campaignId: 1,
          campaignCode: 'CAMP1',
          tenantId: 42,
          countryId: 1,
          status: 'active',
          startDate: '',
          endDate: '',
          budget: { amount: '0', currency: 'USD' },
          maxParticipants: 0,
          merchants: [],
          trackers: [],
          rules: [],
          rewards: [],
          etag: 'etag-2',
          configHash: 'hash-2',
          notModified: false,
          servedAt: 's',
          caps: [],
          sectionsReturned: SECTIONS,
          sectionsOmitted: [],
        },
      });
    };
    const client = buildClient(fakeFetch);

    const result = await client.getCampaignConfig(42, 'CAMP1', SECTIONS, 'etag-1');

    expect(result.campaignCode).toBe('CAMP1');
    expect(result.configHash).toBe('hash-2');
    expect(calls[0].url).toContain('/campaign-config/tenants/42/campaigns/CAMP1');
    expect(calls[0].url).toContain('etag=etag-1');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('etag-1');
  });

  it('getCampaignConfig: a 304 answers notModified:true without throwing', async () => {
    const fakeFetch: typeof fetch = async () => jsonResponse(304, null);
    const client = buildClient(fakeFetch);

    const result = await client.getCampaignConfig(42, 'CAMP1', SECTIONS, 'still-current-etag');

    expect(result.notModified).toBe(true);
    expect(result.campaignCode).toBe('CAMP1');
    expect(result.etag).toBe('still-current-etag');
  });

  it('a non-2xx/non-304 response throws PortalConfigRestError carrying the HTTP status', async () => {
    const fakeFetch: typeof fetch = async () => jsonResponse(401, { error: { message: 'nope' } });
    const client = buildClient(fakeFetch);

    await expect(client.listActiveCampaigns(42, SECTIONS)).rejects.toMatchObject({
      name: 'PortalConfigRestError',
      status: 401,
    });
  });

  it('a network-level failure (fetch throws) is wrapped in PortalConfigRestError', async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = buildClient(fakeFetch);

    await expect(client.listActiveCampaigns(42, SECTIONS)).rejects.toThrow(PortalConfigRestError);
  });

  it('an unparseable JSON body throws PortalConfigRestError rather than propagating the parse error raw', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } });
    const client = buildClient(fakeFetch);

    await expect(client.listActiveCampaigns(42, SECTIONS)).rejects.toThrow(PortalConfigRestError);
  });

  it('omits the sections query param entirely when the sections list is empty', async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse(200, {
        data: { campaigns: [], servedAt: 's', sectionsReturned: [], sectionsOmitted: [] },
      });
    };
    const client = buildClient(fakeFetch);

    await client.listActiveCampaigns(42, []);

    expect(calls[0]).toBe('http://portal.test/api/v1/campaign-config/tenants/42/campaigns');
  });
});
