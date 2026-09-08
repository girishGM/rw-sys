/**
 * T-INT-012. REST fallback transport for this service's campaign-config client, calling
 * `portal/back-end`'s REST mirror of `CampaignConfigService` (T-INT-010,
 * `portal/back-end/src/modules/campaign-config-api/`) — the practical *default* transport once
 * this service runs on Render (no managed gRPC/mTLS endpoint reachable from the free tier yet,
 * `ARCHITECTURE.md` §1). An explicit direct port of RAP's own identical REST client
 * (`realtime-activity-processing-service/src/modules/campaign-cache/portal-config-rest.client.ts`,
 * T-INT-011 — confirmed by direct read before diverging in shape, per this task's own
 * implementation note 1), with one difference specific to this service, mirroring the exact
 * difference `campaign-config.client.ts`'s own header already documents between the two services'
 * gRPC clients: **only `[BASIC, MERCHANTS, TRACKERS, REWARDS, CAPS]` is ever requested — never
 * `RULES`** (this service has no use for rule expressions; `RULES` isn't in this file's own
 * `ConfigSectionName` type at all, imported from `campaign-config.client.ts`).
 *
 * No business logic lives here (matches `CampaignConfigClient`'s own header: "pure transport
 * plumbing... no caching/indexing logic, no business logic") — this class only knows how to make
 * two GET calls and shape their response, mirroring `CampaignConfigClient`'s own two public methods
 * so `campaign-config.client.ts` can branch between the two transports without either one knowing
 * the other exists.
 *
 * **Auth**: T-INT-010's `ServiceApiAuthGuard` needs two things this client sends on every request —
 * a shared bearer secret (`Authorization: Bearer <PORTAL_REST_API_TOKEN>`, portal's own
 * `CAMPAIGN_CONFIG_API_TOKEN`) proving "this is a legitimate internal caller", and an
 * `X-Service-Identity` header naming which `grpc_service_grants` row's tenant/section grants apply
 * (`PORTAL_REST_SERVICE_IDENTITY` — reuses the *same* `grpc_service_grants` table gRPC already
 * reads, just a different identification channel: a header instead of a certificate SAN). Provisioning
 * a real grant row for this identity, and setting the matching `CAMPAIGN_CONFIG_API_TOKEN` value on
 * the portal side, is an operational/deployment concern, not a development one — same precedent
 * `campaign-config.client.ts`'s own header already establishes for gRPC's mTLS material.
 *
 * **304 handling**: T-INT-010's `getCampaignConfig` answers a still-current `etag`/`If-None-Match`
 * with a genuine HTTP `304` and an *empty* body, but it still sets the `ETag` response header first,
 * unconditionally, before that branch. This client reads that header and synthesizes the same
 * minimal, `notModified: true` `CampaignConfigProto` shape the gRPC transport already returns for
 * its own not-modified case, so `campaign-config.client.ts`'s own callers never need a
 * transport-specific branch for this case either.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  CAMPAIGN_CONFIG_SECTIONS,
  type CampaignConfigListProto,
  type CampaignConfigProto,
  type ConfigSectionName,
} from './campaign-config.client';

export const DEFAULT_PORTAL_REST_BASE_URL = 'http://localhost:3001/api/v1';
export const DEFAULT_PORTAL_REST_TIMEOUT_MS = 5_000;

export class MissingPortalRestTokenError extends Error {
  constructor() {
    super(
      'Missing required environment variable PORTAL_REST_API_TOKEN — set it in .env.development ' +
        '(see .env.example) before PortalConfigRestClient can call the portal REST surface. Must ' +
        "match the portal's own CAMPAIGN_CONFIG_API_TOKEN value (operational provisioning, not a " +
        'default this codebase can safely ship).',
    );
    this.name = 'MissingPortalRestTokenError';
  }
}

export class MissingPortalRestServiceIdentityError extends Error {
  constructor() {
    super(
      'Missing required environment variable PORTAL_REST_SERVICE_IDENTITY — set it in ' +
        '.env.development (see .env.example) to the service_identity granted to this instance in ' +
        "the portal's own grpc_service_grants table (the same table its gRPC transport already " +
        'reads, just named via a header instead of a certificate SAN).',
    );
    this.name = 'MissingPortalRestServiceIdentityError';
  }
}

export interface PortalConfigRestClientOptions {
  baseUrl: string;
  token: string;
  serviceIdentity: string;
  timeoutMs: number;
}

function parsePositiveInt(raw: string | undefined, envVarName: string, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${envVarName}: "${raw}" is not a positive integer`);
  }
  return parsed;
}

export function loadPortalRestToken(): string {
  const token = process.env.PORTAL_REST_API_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new MissingPortalRestTokenError();
  }
  return token;
}

export function loadPortalRestServiceIdentity(): string {
  const identity = process.env.PORTAL_REST_SERVICE_IDENTITY;
  if (!identity || identity.trim().length === 0) {
    throw new MissingPortalRestServiceIdentityError();
  }
  return identity;
}

export function loadPortalConfigRestClientOptions(): PortalConfigRestClientOptions {
  const baseUrl = process.env.PORTAL_REST_BASE_URL?.trim() || DEFAULT_PORTAL_REST_BASE_URL;
  const timeoutMs = parsePositiveInt(
    process.env.PORTAL_REST_TIMEOUT_MS,
    'PORTAL_REST_TIMEOUT_MS',
    DEFAULT_PORTAL_REST_TIMEOUT_MS,
  );
  return {
    baseUrl,
    token: loadPortalRestToken(),
    serviceIdentity: loadPortalRestServiceIdentity(),
    timeoutMs,
  };
}

interface DataEnvelope<T> {
  data: T;
}

function sectionsQuery(sections: readonly ConfigSectionName[]): string {
  return sections.length > 0 ? `sections=${sections.join(',')}` : '';
}

/** The minimal, `notModified: true` shape this client synthesizes for a real `304` — every list
 * field empty, every scalar its zero value, `etag` the header value the `304` itself carried.
 * Mirrors the gRPC transport's own not-modified response shape field-for-field. */
function notModifiedResponse(etag: string): CampaignConfigProto {
  return {
    campaignId: 0,
    campaignCode: '',
    tenantId: 0,
    countryId: 0,
    status: '',
    startDate: '',
    endDate: '',
    budget: undefined,
    maxParticipants: 0,
    merchants: [],
    trackers: [],
    rewards: [],
    etag,
    configHash: '',
    notModified: true,
    servedAt: new Date().toISOString(),
    caps: [],
    sectionsReturned: [],
    sectionsOmitted: [],
  };
}

/**
 * Injectable — mirrors `CampaignConfigClient`'s own two read methods
 * (`listActiveCampaigns`/`getCampaignConfig`); no REST equivalent of a `watchCampaignConfig` exists
 * here either — this service has no such method at all on its own `CampaignConfigClient`
 * (implementation note 4 of this task's own file: "RR has no `WatchCampaignConfig`-equivalent
 * streaming consumer today"), so unlike RAP's own client, there is no streaming case for this class
 * to leave out — there was never one to begin with.
 */
@Injectable()
export class PortalConfigRestClient {
  private readonly logger = new Logger(PortalConfigRestClient.name);

  /** `@Optional()`-defaulted for the identical reason `RewardTrackingRestClient`'s own constructor
   * documents (T-RR-064): `options`'s type is a plain interface, erased at compile time, so real
   * Nest DI (no bound provider for this token) resolves the parameter to `undefined` rather than
   * throwing, and the JS-level default then runs `loadPortalConfigRestClientOptions()` for real. */
  constructor(
    @Optional()
    private readonly options: PortalConfigRestClientOptions = loadPortalConfigRestClientOptions(),
  ) {}

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.token}`,
      'X-Service-Identity': this.options.serviceIdentity,
    };
  }

  private async get<T>(
    path: string,
  ): Promise<{ status: number; body: T | undefined; etagHeader: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${this.options.baseUrl}${path}`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: controller.signal,
      });
      const etagHeader = response.headers.get('etag');
      if (response.status === 304) {
        return { status: 304, body: undefined, etagHeader };
      }
      if (!response.ok) {
        throw new Error(`portal REST call to ${path} failed with HTTP status ${response.status}`);
      }
      const body = (await response.json()) as T;
      return { status: response.status, body, etagHeader };
    } catch (error) {
      this.logger.warn(
        `REST call to portal (${path}) failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Mirrors `CampaignConfigClient#listActiveCampaigns` exactly — same parameters, same return
   * shape. No not-modified case exists for this endpoint (`campaign-config-api.controller.ts`
   * always answers `200`, `Cache-Control: no-store`, no `ETag`). */
  async listActiveCampaigns(
    tenantId: number,
    sections: readonly ConfigSectionName[] = CAMPAIGN_CONFIG_SECTIONS,
  ): Promise<CampaignConfigListProto> {
    const query = sectionsQuery(sections);
    const path = `/campaign-config/tenants/${tenantId}/campaigns${query ? `?${query}` : ''}`;
    const { body } = await this.get<DataEnvelope<CampaignConfigListProto>>(path);
    if (!body) {
      throw new Error(`portal REST listActiveCampaigns (${path}) returned an empty body`);
    }
    return body.data;
  }

  /** Mirrors `CampaignConfigClient#getCampaignConfig` exactly. A `304` (etag still current)
   * synthesizes {@link notModifiedResponse} instead of throwing — this is success, not failure,
   * matching gRPC's own `notModified: true` outcome for the identical case. */
  async getCampaignConfig(
    tenantId: number,
    campaignCode: string,
    sections: readonly ConfigSectionName[] = CAMPAIGN_CONFIG_SECTIONS,
    etag = '',
  ): Promise<CampaignConfigProto> {
    const params: string[] = [];
    const sectionsPart = sectionsQuery(sections);
    if (sectionsPart) params.push(sectionsPart);
    if (etag) params.push(`etag=${encodeURIComponent(etag)}`);
    const path =
      `/campaign-config/tenants/${tenantId}/campaigns/${encodeURIComponent(campaignCode)}` +
      (params.length > 0 ? `?${params.join('&')}` : '');

    const { status, body, etagHeader } = await this.get<DataEnvelope<CampaignConfigProto>>(path);
    if (status === 304) {
      return notModifiedResponse(etagHeader ?? etag);
    }
    if (!body) {
      throw new Error(`portal REST getCampaignConfig (${path}) returned an empty body`);
    }
    return body.data;
  }
}
