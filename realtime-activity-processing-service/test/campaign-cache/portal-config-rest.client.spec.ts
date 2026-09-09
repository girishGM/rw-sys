/**
 * T-INT-011 — `PortalConfigRestClient` against a mocked global `fetch` (Node 20's own built-in
 * implementation, no extra HTTP-client dependency added), the same deterministic, no-real-network
 * pattern `reward-tracking-rest.client.spec.ts` (T-RR-035/T-INT-002) already established for the
 * equivalent REST-fallback client in `reward-redemption-service`. Asserts the *outgoing request*
 * this client actually builds (URL, headers, query string) against portal's real, shipped contract
 * (`campaign-config-api.controller.ts`) — `AGENT-PROTOCOL.md` §3's "assert the observable property"
 * discipline — not just a change-detector on an internal constant.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  CampaignConfigListProto,
  CampaignConfigProto,
} from '@/modules/campaign-cache/campaign-config.client';
import {
  DEFAULT_PORTAL_REST_BASE_URL,
  DEFAULT_PORTAL_REST_TIMEOUT_MS,
  MissingPortalRestServiceIdentityError,
  MissingPortalRestTokenError,
  PortalConfigRestClient,
  loadPortalConfigRestClientOptions,
  loadPortalRestServiceIdentity,
  loadPortalRestToken,
} from '@/modules/campaign-cache/portal-config-rest.client';

const ORIGINAL_ENV = { ...process.env };

function fakeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function sampleCampaign(overrides: Partial<CampaignConfigProto> = {}): CampaignConfigProto {
  return {
    campaignId: 1,
    campaignCode: 'CMP-1',
    tenantId: 7,
    countryId: 1,
    status: 'ACTIVE',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    budget: { amount: '1000', currency: 'USD' },
    maxParticipants: 100,
    merchants: [],
    trackers: [],
    rules: [],
    rewards: [],
    etag: 'etag-1',
    configHash: 'hash-1',
    notModified: false,
    servedAt: '2026-09-07T00:00:00.000Z',
    caps: [],
    sectionsReturned: ['BASIC'],
    sectionsOmitted: [],
    ...overrides,
  };
}

describe('T-INT-011 — PortalConfigRestClient', () => {
  let fetchSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    fetchSpy = jest.spyOn(global, 'fetch');
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    process.env = { ...ORIGINAL_ENV };
  });

  function buildClient(
    overrides: Partial<{
      baseUrl: string;
      token: string;
      serviceIdentity: string;
      timeoutMs: number;
    }> = {},
  ): PortalConfigRestClient {
    return new PortalConfigRestClient({
      baseUrl: 'http://portal.test/api/v1',
      token: 'portal-rest-token',
      serviceIdentity: 'realtime-activity-processing-service',
      timeoutMs: 1000,
      ...overrides,
    });
  }

  describe('loadPortalRestToken / loadPortalRestServiceIdentity / loadPortalConfigRestClientOptions', () => {
    it('throws MissingPortalRestTokenError when PORTAL_REST_API_TOKEN is unset', () => {
      delete process.env.PORTAL_REST_API_TOKEN;
      expect(() => loadPortalRestToken()).toThrow(MissingPortalRestTokenError);
    });

    it('throws when PORTAL_REST_API_TOKEN is only whitespace', () => {
      process.env.PORTAL_REST_API_TOKEN = '   ';
      expect(() => loadPortalRestToken()).toThrow(MissingPortalRestTokenError);
    });

    it('throws MissingPortalRestServiceIdentityError when PORTAL_REST_SERVICE_IDENTITY is unset', () => {
      delete process.env.PORTAL_REST_SERVICE_IDENTITY;
      expect(() => loadPortalRestServiceIdentity()).toThrow(MissingPortalRestServiceIdentityError);
    });

    it('falls back to documented defaults for base URL/timeout when unset', () => {
      process.env.PORTAL_REST_API_TOKEN = 'tok';
      process.env.PORTAL_REST_SERVICE_IDENTITY = 'rap';
      delete process.env.PORTAL_REST_BASE_URL;
      delete process.env.PORTAL_REST_TIMEOUT_MS;
      const options = loadPortalConfigRestClientOptions();
      expect(options.baseUrl).toBe(DEFAULT_PORTAL_REST_BASE_URL);
      expect(options.timeoutMs).toBe(DEFAULT_PORTAL_REST_TIMEOUT_MS);
    });

    it('rejects a non-positive-integer PORTAL_REST_TIMEOUT_MS', () => {
      process.env.PORTAL_REST_API_TOKEN = 'tok';
      process.env.PORTAL_REST_SERVICE_IDENTITY = 'rap';
      process.env.PORTAL_REST_TIMEOUT_MS = 'nope';
      expect(() => loadPortalConfigRestClientOptions()).toThrow(/PORTAL_REST_TIMEOUT_MS/);
    });
  });

  describe('listActiveCampaigns', () => {
    it('GETs the real T-INT-010 route with the required auth headers', async () => {
      const campaigns = [sampleCampaign()];
      const responsePayload: { data: CampaignConfigListProto } = {
        data: { campaigns, servedAt: 'now', sectionsReturned: [], sectionsOmitted: [] },
      };
      fetchSpy.mockResolvedValue(fakeResponse(200, responsePayload));

      const client = buildClient({ token: 'super-secret', serviceIdentity: 'rap-identity' });
      const result = await client.listActiveCampaigns(7, ['BASIC', 'RULES']);

      expect(result.campaigns).toEqual(campaigns);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'http://portal.test/api/v1/campaign-config/tenants/7/campaigns?sections=BASIC,RULES',
      );
      expect(init.method).toBe('GET');
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer super-secret',
        'X-Service-Identity': 'rap-identity',
      });
    });

    it('omits the sections query param when no sections are requested', async () => {
      fetchSpy.mockResolvedValue(
        fakeResponse(200, {
          data: { campaigns: [], servedAt: 'now', sectionsReturned: [], sectionsOmitted: [] },
        }),
      );
      const client = buildClient();

      await client.listActiveCampaigns(3, []);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://portal.test/api/v1/campaign-config/tenants/3/campaigns');
    });

    it('throws on a non-2xx response', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(500, { error: 'boom' }));
      const client = buildClient();

      await expect(client.listActiveCampaigns(1)).rejects.toThrow(/500/);
    });

    it('a connection-level failure (fetch rejects) is treated as a failure', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
      const client = buildClient();

      await expect(client.listActiveCampaigns(1)).rejects.toThrow('ECONNREFUSED');
    });

    it('never logs the bearer token on the failure path', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));
      const client = buildClient({ token: 'SUPER-SECRET-BEARER' });

      await expect(client.listActiveCampaigns(1)).rejects.toThrow();

      const loggedText = warnSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
      expect(loggedText).not.toContain('SUPER-SECRET-BEARER');
    });
  });

  describe('getCampaignConfig', () => {
    it('GETs the real T-INT-010 route, forwarding sections and etag as query params', async () => {
      const campaign = sampleCampaign({ campaignCode: 'CMP-9', tenantId: 9 });
      fetchSpy.mockResolvedValue(fakeResponse(200, { data: campaign }));
      const client = buildClient();

      const result = await client.getCampaignConfig(9, 'CMP-9', ['RULES'], 'prior-etag');

      expect(result).toEqual(campaign);
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'http://portal.test/api/v1/campaign-config/tenants/9/campaigns/CMP-9?sections=RULES&etag=prior-etag',
      );
    });

    it('TC-notModified: a real HTTP 304 synthesizes a notModified:true response using the ETag response header', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(304, undefined, { etag: 'current-etag' }));
      const client = buildClient();

      const result = await client.getCampaignConfig(9, 'CMP-9', ['BASIC'], 'current-etag');

      expect(result.notModified).toBe(true);
      expect(result.etag).toBe('current-etag');
      expect(result.merchants).toEqual([]);
      expect(result.trackers).toEqual([]);
    });

    it('a 304 with no ETag header falls back to the etag the caller presented', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(304, undefined, {}));
      const client = buildClient();

      const result = await client.getCampaignConfig(9, 'CMP-9', [], 'presented-etag');

      expect(result.notModified).toBe(true);
      expect(result.etag).toBe('presented-etag');
    });

    it('throws when a 200 response has no body', async () => {
      fetchSpy.mockResolvedValue(fakeResponse(200, undefined));
      const client = buildClient();

      await expect(client.getCampaignConfig(1, 'CMP-1')).rejects.toThrow(/empty body/);
    });
  });

  describe('real Nest DI compiles this provider with no matching provider for `options`', () => {
    it('resolves via NestFactory-style DI using the env-derived default (T-RR-064 precedent)', async () => {
      process.env.PORTAL_REST_API_TOKEN = 'di-resolved-token';
      process.env.PORTAL_REST_SERVICE_IDENTITY = 'di-identity';
      process.env.PORTAL_REST_BASE_URL = 'http://portal.di-test/api/v1';

      const moduleRef = await Test.createTestingModule({
        providers: [PortalConfigRestClient],
      }).compile();

      const client = moduleRef.get(PortalConfigRestClient);
      expect(client).toBeInstanceOf(PortalConfigRestClient);

      fetchSpy.mockResolvedValue(
        fakeResponse(200, {
          data: { campaigns: [], servedAt: 'now', sectionsReturned: [], sectionsOmitted: [] },
        }),
      );
      await client.listActiveCampaigns(1, []);

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://portal.di-test/api/v1/campaign-config/tenants/1/campaigns');
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer di-resolved-token',
        'X-Service-Identity': 'di-identity',
      });

      await moduleRef.close();
    });
  });
});
