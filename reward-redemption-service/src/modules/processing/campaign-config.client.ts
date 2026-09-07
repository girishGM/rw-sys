/**
 * T-RR-022. Thin gRPC client wrapper around the portal's `CampaignConfigService`
 * (`proto/campaign_config.proto`, this service's own client-side copy of
 * `portal/back-end/proto/campaign_config.v1.proto` — see that file's header). Pure transport
 * plumbing — (de)serialization, promisification and error classification only, no caching/
 * indexing logic (that's `CampaignConfigCache`'s job, this module's own sibling file) and no
 * business logic (R10's spirit applies here too, even though R10 itself is about the ingestion
 * transports). A direct port of RAP's own proven `campaign-config.client.ts`
 * (`realtime-activity-processing-service/src/modules/campaign-cache/campaign-config.client.ts`,
 * confirmed by direct read) — same shape, same env-var names, same TLS-optional fallback — with
 * two differences specific to this service:
 *
 *   1. **Only `[BASIC, MERCHANTS, TRACKERS, REWARDS, CAPS]` is ever requested — never `RULES`**
 *      (`03-GRPC-CONTRACT.md` §3's own "Requested sections" note; task implementation note 1).
 *      Unlike RAP's client, which defaults to "every section" and lets its own caller choose, this
 *      client's public methods hardcode the fixed five-section list as their own default and give
 *      callers no way to widen it to include `RULES` — this service structurally has no use for
 *      rule expressions and should not even be capable of asking for them (the whole point of
 *      `ConfigSection` being "an authorisation boundary, not a bandwidth optimisation").
 *   2. **A `PERMISSION_DENIED` response is classified into a distinct, named
 *      `PortalGrantNotProvisionedError`** (implementation note 6, TC-6) — RAP's own client lets a
 *      `PERMISSION_DENIED` propagate as a bare `grpc.ServiceError`, which is fine for RAP (an
 *      already-granted, long-running service) but would leave an operator debugging *this*
 *      service's fresh deploy staring at an opaque gRPC error code instead of the specific,
 *      actionable "the `grpc_service_grants` row for this identity/tenant/section-list hasn't been
 *      provisioned yet" diagnosis this task's own note 2 asks for.
 *
 * Env vars read directly from `process.env`, not `ConfigService`/`src/config/config.schema.ts`:
 * that shared schema is outside this task's file scope (`src/config/**` is
 * `agent-rr-foundation`'s), matching `config.schema.ts`'s own header, which explicitly calls out
 * "the `PORTAL_GRPC_*` client vars (T-RR-022)" as one of the vars deliberately left for this task
 * to read on its own — the identical precedent RAP's own client already set for the same reason.
 */
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

/** The only five sections this service is ever allowed to ask for (`03-GRPC-CONTRACT.md` §3) —
 * `RULES` is deliberately absent, not merely unused. */
export type ConfigSectionName = 'BASIC' | 'MERCHANTS' | 'TRACKERS' | 'REWARDS' | 'CAPS';

export const CAMPAIGN_CONFIG_SECTIONS: readonly ConfigSectionName[] = Object.freeze([
  'BASIC',
  'MERCHANTS',
  'TRACKERS',
  'REWARDS',
  'CAPS',
]);

export interface MoneyProto {
  amount: string;
  currency: string;
}

export interface ActivityProto {
  activityId: number;
  activityCode: string;
  name: string;
  externalCodes: string[];
}

export interface MerchantProto {
  merchantId: number;
  merchantCode: string;
  name: string;
  status: string;
  activities: ActivityProto[];
}

export interface TrackerComponentProto {
  componentId: number;
  componentCode: string;
  name: string;
  activityId: number;
  sequenceOrder: number;
  isMandatory: boolean;
  status: string;
}

export interface TrackerProto {
  trackerId: number;
  trackerCode: string;
  name: string;
  completionLogic: string;
  completionThreshold: number;
  status: string;
  components: TrackerComponentProto[];
}

/** `connector_config` is deliberately absent — see this module's own header, implementation note
 * 3, and the portal proto's own rule 4. Never add it here even defensively. */
export interface BoundRewardProto {
  rewardId: number;
  rewardVersionId: number;
  versionNo: number;
  systemCode: string;
  rewardType: string;
  deliveryMode: string;
  policiesJson: string;
  unitType: string;
  unitCode: string;
  level: string;
  refId: number;
  status: string;
}

export interface CampaignCapProto {
  capClass: string;
  scopeLevel: string;
  scopeRefId: number;
  periodType: string;
  periodValue: number;
  windowStartTime: string;
  windowEndTime: string;
  periodTimezone: string;
  unitType: string;
  unitCode: string;
  rewardType: string;
  maxTotalAmount: string;
  maxOccurrences: number;
  maxCustomers: number;
  onBreach: string;
  warnAtPercent: number;
}

export interface CampaignConfigProto {
  campaignId: number;
  campaignCode: string;
  tenantId: number;
  countryId: number;
  status: string;
  startDate: string;
  endDate: string;
  budget: MoneyProto | undefined;
  maxParticipants: number;
  merchants: MerchantProto[];
  trackers: TrackerProto[];
  rewards: BoundRewardProto[];
  etag: string;
  configHash: string;
  notModified: boolean;
  servedAt: string;
  caps: CampaignCapProto[];
  sectionsReturned: ConfigSectionName[];
  sectionsOmitted: ConfigSectionName[];
}

export interface CampaignConfigListProto {
  campaigns: CampaignConfigProto[];
  servedAt: string;
  sectionsReturned: ConfigSectionName[];
  sectionsOmitted: ConfigSectionName[];
}

/** Shape of the dynamically-loaded `CampaignConfigService` grpc-js client this file wraps —
 * narrowed to the two RPCs this service actually calls (implementation note 1's own "no RULES"
 * boundary has no bearing on which RPCs exist on the wire, only which sections a call may name). */
interface RawCampaignConfigServiceClient extends grpc.Client {
  getCampaignConfig(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: CampaignConfigProto) => void,
  ): grpc.ClientUnaryCall;
  listActiveCampaigns(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: CampaignConfigListProto) => void,
  ): grpc.ClientUnaryCall;
}

export const DEFAULT_PORTAL_GRPC_PORT = 50051;
/** Matches RAP's own outbound-call deadline convention (confirmed by direct read) — generous
 * enough for a real network hop, short enough that a genuinely unreachable portal fails a
 * cold-start attempt within a bounded time rather than hanging the whole boot sequence. */
export const DEFAULT_PORTAL_GRPC_TIMEOUT_MS = 5_000;

export interface CampaignConfigClientOptions {
  host: string;
  port: number;
  timeoutMs: number;
  tls?: {
    rootCerts: Buffer;
    clientCert: Buffer;
    clientKey: Buffer;
  };
}

/** Implementation note 6 / TC-6: a `PERMISSION_DENIED` from the portal means this service's own
 * `grpc_service_grants` identity/tenant/section grant hasn't been provisioned (or is missing one
 * of the sections this client asks for) — a real, expected failure mode in a fresh environment,
 * never confused with a generic connection/timeout failure. Carries the original `grpc.ServiceError`
 * so nothing about the underlying cause is lost, only reclassified with a clear name and message
 * an operator can act on directly. */
export class PortalGrantNotProvisionedError extends Error {
  constructor(
    rpcName: string,
    tenantId: number,
    public readonly cause: grpc.ServiceError,
  ) {
    super(
      `Portal denied "${rpcName}" for tenant_id=${tenantId} with PERMISSION_DENIED — this ` +
        `service's own grpc_service_grants row (SAN -> tenant_id -> section list) has not been ` +
        `provisioned yet, or is missing one of the sections this client requests ` +
        `(${CAMPAIGN_CONFIG_SECTIONS.join(', ')}). This is an operator-side administrative step ` +
        `on the portal (03-GRPC-CONTRACT.md §3), not something this service's own code can fix.`,
    );
    this.name = 'PortalGrantNotProvisionedError';
  }
}

/** `PORTAL_GRPC_HOST`/`PORTAL_GRPC_PORT` default to `localhost`/50051 (the portal's own
 * `GRPC_DEFAULT_PORT`) — overridable per environment. TLS material is optional; all three paths
 * must be set together or none are used (a partially-configured mTLS setup is a misconfiguration,
 * not a silent insecure fallback) — the identical rule RAP's own client already enforces. */
export function loadCampaignConfigClientOptions(): CampaignConfigClientOptions {
  const host = process.env.PORTAL_GRPC_HOST?.trim() || 'localhost';
  const rawPort = process.env.PORTAL_GRPC_PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_PORTAL_GRPC_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORTAL_GRPC_PORT: "${rawPort}" is not a positive integer`);
  }

  const rawTimeout = process.env.PORTAL_GRPC_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number.parseInt(rawTimeout, 10) : DEFAULT_PORTAL_GRPC_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid PORTAL_GRPC_TIMEOUT_MS: "${rawTimeout}" is not a positive integer`);
  }

  const caPath = process.env.PORTAL_GRPC_TLS_CA_PATH?.trim();
  const certPath = process.env.PORTAL_GRPC_TLS_CERT_PATH?.trim();
  const keyPath = process.env.PORTAL_GRPC_TLS_KEY_PATH?.trim();

  if (!caPath && !certPath && !keyPath) {
    return { host, port, timeoutMs };
  }
  if (!caPath || !certPath || !keyPath) {
    throw new Error(
      'Invalid gRPC client TLS configuration: PORTAL_GRPC_TLS_CA_PATH, PORTAL_GRPC_TLS_CERT_PATH ' +
        'and PORTAL_GRPC_TLS_KEY_PATH must all be set together, or none of them (got a partial set)',
    );
  }

  return {
    host,
    port,
    timeoutMs,
    tls: {
      rootCerts: readFileSync(caPath),
      clientCert: readFileSync(certPath),
      clientKey: readFileSync(keyPath),
    },
  };
}

/** Comma-separated tenant ids this instance manages (`.env.example`'s own
 * `PORTAL_CONFIG_TENANT_IDS` documentation, already written ahead of this task) — read here since
 * it is this client/cache pairing's own concern (which tenants to warm/reconcile), not a bootstrap
 * connection concern `config.schema.ts` would validate. */
export function loadPortalConfigTenantIds(): number[] {
  const raw = process.env.PORTAL_CONFIG_TENANT_IDS?.trim();
  if (!raw) {
    throw new Error(
      'PORTAL_CONFIG_TENANT_IDS is required (comma-separated tenant ids, e.g. "1,2")',
    );
  }
  const ids = raw.split(',').map((part) => {
    const id = Number.parseInt(part.trim(), 10);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Invalid PORTAL_CONFIG_TENANT_IDS entry "${part}": not a positive integer`);
    }
    return id;
  });
  return ids;
}

function resolveProtoPath(): string {
  return join(__dirname, '..', '..', '..', 'proto', 'campaign_config.proto');
}

function buildCredentials(options: CampaignConfigClientOptions): grpc.ChannelCredentials {
  if (!options.tls) {
    return grpc.credentials.createInsecure();
  }
  return grpc.credentials.createSsl(
    options.tls.rootCerts,
    options.tls.clientKey,
    options.tls.clientCert,
  );
}

/**
 * Injectable — one instance per process, holding one long-lived gRPC channel to the portal
 * (`ARCHITECTURE.md` §10: "each service instance ... opens its own stream at startup and keeps it
 * open for the life of the process" — the same convention this client reuses for its unary calls,
 * even though this service never opens `WatchCampaignConfig`'s own stream, §4 of
 * `06-CACHING-AND-TENANT-CONFIG.md`).
 */
@Injectable()
export class CampaignConfigClient implements OnModuleDestroy {
  private readonly logger = new Logger(CampaignConfigClient.name);
  private readonly client: RawCampaignConfigServiceClient;
  private readonly timeoutMs: number;

  /**
   * T-RR-055. `@Optional()` on `options` is the actual fix, not a decoration. `options`'s type is
   * a plain interface — erased at compile time — so TypeScript's emitted `design:paramtypes`
   * metadata for this constructor parameter is `undefined`/`Object`, which Nest's automatic
   * constructor-injection cannot map to any registered provider token. Without `@Optional()`,
   * Nest treats "no provider found for this token" as a hard failure and throws
   * `"Nest can't resolve dependencies of the CampaignConfigClient (?)"` at module-compile time,
   * before this constructor body — or its JS-level default parameter — ever runs at all. With
   * `@Optional()`, an unresolvable constructor dependency resolves to `undefined` instead of
   * throwing, and Nest then calls this constructor with `undefined` in that argument position;
   * confirmed experimentally (a throwaway `Test.createTestingModule` spec against an isolated
   * `@Optional() x = default()`-shaped provider) that a JS default parameter *does* still apply
   * when the caller passes `undefined` explicitly, not only when the argument is omitted from the
   * call entirely — so `loadCampaignConfigClientOptions()` still runs and this class still gets a
   * real, env-derived options object when constructed via real Nest DI with no matching provider.
   * Every existing unit test in `campaign-config.client.spec.ts` is unaffected: each one
   * constructs this class with `new CampaignConfigClient(options)`, always passing an explicit,
   * fully-formed argument, so none of them relies on — or changes behaviour around — this default
   * at all.
   */
  constructor(
    @Optional() options: CampaignConfigClientOptions = loadCampaignConfigClientOptions(),
  ) {
    this.timeoutMs = options.timeoutMs;

    const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      rewardportal: {
        config: { v1: { CampaignConfigService: new (...args: unknown[]) => grpc.Client } };
      };
    };
    const ServiceCtor = proto.rewardportal.config.v1.CampaignConfigService;
    const credentials = buildCredentials(options);
    this.client = new ServiceCtor(
      `${options.host}:${options.port}`,
      credentials,
    ) as RawCampaignConfigServiceClient;
  }

  private deadline(): grpc.CallOptions {
    return { deadline: Date.now() + this.timeoutMs };
  }

  async listActiveCampaigns(
    tenantId: number,
    sections: readonly ConfigSectionName[] = CAMPAIGN_CONFIG_SECTIONS,
  ): Promise<CampaignConfigListProto> {
    return new Promise((resolve, reject) => {
      this.client.listActiveCampaigns(
        { tenantId, sections },
        new grpc.Metadata(),
        this.deadline(),
        (error, response) => {
          if (error) {
            reject(this.classifyError('ListActiveCampaigns', tenantId, error));
            return;
          }
          resolve(response);
        },
      );
    });
  }

  async getCampaignConfig(
    tenantId: number,
    campaignCode: string,
    sections: readonly ConfigSectionName[] = CAMPAIGN_CONFIG_SECTIONS,
    etag = '',
  ): Promise<CampaignConfigProto> {
    return new Promise((resolve, reject) => {
      this.client.getCampaignConfig(
        { tenantId, campaignCode, sections, etag },
        new grpc.Metadata(),
        this.deadline(),
        (error, response) => {
          if (error) {
            reject(this.classifyError('GetCampaignConfig', tenantId, error));
            return;
          }
          resolve(response);
        },
      );
    });
  }

  /** Implementation note 6 / TC-6: reclassifies `PERMISSION_DENIED` into a distinct, named,
   * clearly-logged error — every other gRPC failure (transient network errors, `UNAVAILABLE`,
   * a deadline exceeded) propagates unchanged, since those genuinely are generic
   * connection-shaped failures with no more specific diagnosis this client can add. */
  private classifyError(rpcName: string, tenantId: number, error: grpc.ServiceError): Error {
    if (error.code === grpc.status.PERMISSION_DENIED) {
      const classified = new PortalGrantNotProvisionedError(rpcName, tenantId, error);
      this.logger.error(classified.message);
      return classified;
    }
    return error;
  }

  onModuleDestroy(): void {
    this.client.close();
  }
}
