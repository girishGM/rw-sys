/**
 * T-INT-013. `PortalConfigRestClient` — the REST transport counterpart to
 * `CampaignHierarchyClient`'s existing gRPC wrapper, calling the REST mirror of the portal's
 * `CampaignConfigService` that T-INT-010 built
 * (`portal/back-end/src/modules/campaign-config-api/campaign-config-api.controller.ts`):
 * `GET /api/v1/campaign-config/tenants/:tenantId/campaigns` and
 * `.../campaigns/:campaignCode`.
 *
 * `CampaignConfigProto`/`CampaignConfigListProto`/`ConfigSectionName` are imported as **types
 * only** from `./campaign-hierarchy.client` — that response DTO is deliberately field-for-field
 * identical to the gRPC wire message (`campaign-config-response.dto.ts`'s own header: "so a client
 * of both transports... never needs a transport-specific parsing branch"), so this file reuses the
 * exact same shapes rather than declaring a parallel set. A **type-only** import is what keeps
 * this from being a real circular runtime dependency with `campaign-hierarchy.client.ts` (which
 * imports this file's own runtime class) — TypeScript erases `import type` entirely, so at
 * runtime this module has no dependency on that one.
 *
 * Auth, per `service-api-auth.guard.ts`'s own contract (T-INT-010): `Authorization: Bearer
 * <PORTAL_CAMPAIGN_CONFIG_API_TOKEN>` plus `X-Service-Identity: <PORTAL_SERVICE_IDENTITY>`, naming
 * a `reward_portal.grpc_service_grants` row a portal `super_admin` must provision administratively
 * (the same table gRPC's own mTLS trust domain reads — see that guard's header, and
 * `campaign-hierarchy.client.ts`'s own header on `grpc_service_grants` never being something this
 * code provisions).
 *
 * Uses Node 20's built-in global `fetch` (`undici`) — no new dependency, matching
 * `test-app/tracking-service/src/portal-client/client.ts`'s own `FetchLike` convention (this
 * service has no existing outbound-HTTP client to otherwise follow).
 */
import type {
  CampaignConfigListProto,
  CampaignConfigProto,
  ConfigSectionName,
} from './campaign-hierarchy.client';

type FetchLike = typeof fetch;

export interface PortalConfigRestClientOptions {
  /** e.g. `http://localhost:3001` — no trailing slash required, one is stripped if present. */
  baseUrl: string;
  token: string;
  serviceIdentity: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

export const DEFAULT_PORTAL_REST_BASE_URL = 'http://localhost:3001';
/** Matches `campaign-hierarchy.client.ts`'s own gRPC-fallback deadline convention. */
export const DEFAULT_PORTAL_REST_TIMEOUT_MS = 5_000;

/** Thrown for any REST-transport failure — network error, timeout, non-2xx status — so
 * `CampaignHierarchyClient`'s own fallback logic can catch this uniformly regardless of cause,
 * the same way a `grpc.ServiceError` is caught on the gRPC path. */
export class PortalConfigRestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PortalConfigRestError';
  }
}

/** `PORTAL_REST_BASE_URL`/`PORTAL_REST_TIMEOUT_MS` default per this file's own constants above.
 * `PORTAL_CAMPAIGN_CONFIG_API_TOKEN`/`PORTAL_SERVICE_IDENTITY` have no sane default — both are
 * required for this client to ever be usable, so a missing one throws (the same
 * "throw, let the caller catch it and log a clear warning" contract
 * `resolveConfiguredTenantIds`/`loadCampaignHierarchyClientOptions` already use in this module),
 * never silently degrading to an unauthenticated call the portal would just 401. */
export function loadPortalConfigRestClientOptions(): PortalConfigRestClientOptions {
  const baseUrl = process.env.PORTAL_REST_BASE_URL?.trim() || DEFAULT_PORTAL_REST_BASE_URL;

  const rawTimeout = process.env.PORTAL_REST_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number.parseInt(rawTimeout, 10) : DEFAULT_PORTAL_REST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid PORTAL_REST_TIMEOUT_MS: "${rawTimeout}" is not a positive integer`);
  }

  const token = process.env.PORTAL_CAMPAIGN_CONFIG_API_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'PORTAL_CAMPAIGN_CONFIG_API_TOKEN is required for the REST transport to portal-config — ' +
        "without it every call would be refused with 401 by the portal's own ServiceApiAuthGuard.",
    );
  }

  const serviceIdentity = process.env.PORTAL_SERVICE_IDENTITY?.trim();
  if (!serviceIdentity) {
    throw new Error(
      'PORTAL_SERVICE_IDENTITY is required for the REST transport to portal-config — names the ' +
        'reward_portal.grpc_service_grants row this service presents (the X-Service-Identity ' +
        'header), same table the gRPC transport already relies on.',
    );
  }

  return { baseUrl: stripTrailingSlash(baseUrl), token, serviceIdentity, timeoutMs };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function sectionsQueryParam(sections: readonly ConfigSectionName[]): string {
  return sections.length > 0 ? `sections=${sections.join(',')}` : '';
}

export class PortalConfigRestClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly serviceIdentity: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: PortalConfigRestClientOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.token = options.token;
    this.serviceIdentity = options.serviceIdentity;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listActiveCampaigns(
    tenantId: number,
    sections: readonly ConfigSectionName[],
  ): Promise<CampaignConfigListProto> {
    const query = sectionsQueryParam(sections);
    const path = `/api/v1/campaign-config/tenants/${tenantId}/campaigns${query ? `?${query}` : ''}`;
    const envelope = await this.getJson<{ data: CampaignConfigListProto }>(path);
    return envelope.data;
  }

  async getCampaignConfig(
    tenantId: number,
    campaignCode: string,
    sections: readonly ConfigSectionName[],
    etag = '',
  ): Promise<CampaignConfigProto> {
    const params = new URLSearchParams();
    if (sections.length > 0) params.set('sections', sections.join(','));
    if (etag) params.set('etag', etag);
    const qs = params.toString();
    const path =
      `/api/v1/campaign-config/tenants/${tenantId}/campaigns/${encodeURIComponent(campaignCode)}` +
      (qs ? `?${qs}` : '');

    const response = await this.request(path, etag ? { 'If-None-Match': etag } : undefined);
    if (response.status === 304) {
      // The REST substitute for gRPC's `notModified: true` (campaign-config-api.controller.ts's
      // own implementation note 3) — this call site (`getCampaignConfigViaRest`, invoked only
      // from `handleChangeEvent` with `etag: ''`) never actually presents a prior etag today, so
      // this branch exists for completeness/parity, not because it is currently exercised.
      return {
        campaignId: 0,
        campaignCode,
        tenantId,
        countryId: 0,
        status: '',
        startDate: '',
        endDate: '',
        budget: undefined,
        maxParticipants: 0,
        merchants: [],
        trackers: [],
        rules: [],
        rewards: [],
        etag,
        configHash: '',
        notModified: true,
        servedAt: '',
        caps: [],
        sectionsReturned: [],
        sectionsOmitted: [],
      };
    }
    const body = await this.parseJson<{ data: CampaignConfigProto }>(response, path);
    return body.data;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path);
    return this.parseJson<T>(response, path);
  }

  private async request(path: string, extraHeaders?: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'X-Service-Identity': this.serviceIdentity,
          ...extraHeaders,
        },
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 304) {
        const text = await response.text().catch(() => '');
        throw new PortalConfigRestError(
          `portal-config REST call to ${path} failed: HTTP ${response.status} ${text.slice(0, 200)}`,
          response.status,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof PortalConfigRestError) throw error;
      throw new PortalConfigRestError(
        `portal-config REST call to ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseJson<T>(response: Response, path: string): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new PortalConfigRestError(
        `portal-config REST call to ${path} returned a non-JSON body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
