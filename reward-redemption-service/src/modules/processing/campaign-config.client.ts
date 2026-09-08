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
 *
 * **T-INT-012**: `listActiveCampaigns`/`getCampaignConfig` are no longer gRPC-only. Both now
 * resolve their transport at call time via `PortalConfigChannelResolverService`
 * (`portal-config-channel-resolver.service.ts`, table `portal_config_channel_config`, migration
 * `025`) and branch to either this file's own original gRPC call (renamed `*ViaGrpc`, unchanged,
 * including its own `PortalGrantNotProvisionedError` classification) or `PortalConfigRestClient`
 * (`portal-config-rest.client.ts`, T-INT-010's REST mirror). **Every public method signature is
 * unchanged** (implementation note 3) — every existing caller (`CampaignConfigCache`/
 * `resolution.service.ts`, and the tests listed in this file's own header history) keeps working
 * with zero changes on their side. An explicit direct port of RAP's own identical
 * `callWithTransportFallback` mechanism (T-INT-011, `campaign-config.client.ts` there — confirmed
 * by direct read before diverging in shape), with one structural difference: this service has no
 * `watchCampaignConfig` method to begin with (implementation note 4 — "RR has no
 * `WatchCampaignConfig`-equivalent streaming consumer today"), so there is nothing analogous to
 * port for that RPC.
 *
 * **Resilience contract, deliberately conservative**: if `PortalConfigChannelResolverService`
 * itself fails to resolve (e.g. the DB is unreachable, or `portal_config_channel_config` doesn't
 * exist yet in an environment that hasn't run migration `025`), this client logs a warning and
 * falls straight through to the original, pre-T-INT-012 gRPC-only call — never a hard failure for a
 * resolution problem this class didn't have before this task. Once a channel *is* resolved, a
 * disabled channel (`restEnabled`/`grpcEnabled` false) is simply skipped, never attempted; if the
 * enabled primary fails, the enabled fallback is tried next; if every attempted channel fails, the
 * last error is rethrown — TC-5's own "raises/degrades exactly as it already does today on gRPC
 * failure" contract, and `PortalGrantNotProvisionedError`'s own classification (TC-6, above) is
 * preserved unchanged whichever transport attempt actually reaches it, since it is thrown from
 * inside `getCampaignConfigViaGrpc`/`listActiveCampaignsViaGrpc` themselves, not from the
 * transport-selection wrapper around them.
 */
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  PortalConfigChannelResolverService,
  type PortalConfigChannel,
  type PortalConfigChannelResolveContext,
  type ResolvedPortalConfigChannel,
} from './portal-config-channel-resolver.service';
import { PortalConfigRestClient } from './portal-config-rest.client';

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
  /**
   * T-RR-063 (T-173 on the portal side): a real gRPC response always carries `0`
   * (`protoLoader`'s `defaults: true` always fills the zero value) to mean the reward never
   * expires — matching the proto's own documented sentinel (`proto/campaign_config.proto`'s own
   * `BoundReward` header).
   *
   * **Optional (`?`) on this TypeScript type only** — a real wire response is never missing it.
   * Made optional purely because this interface was already constructed as a full object literal
   * by a fixture predating this task (`test/notification/notification.service.spec.ts`'s own
   * `buildBoundReward()`, outside this task's file scope, R3); `RewardSystemResolutionService.
   * resolve()` (this task's own file) already treats an omitted value identically to an explicit
   * `0` (`match.expiryValue || null`).
   */
  expiryValue?: number;
  /** T-RR-063: `''` means the reward never expires (paired 1:1 with `expiryValue` being `0`/
   * absent) -- otherwise one of `'minutes' | 'hours' | 'days'`. Optional for the identical reason
   * `expiryValue` above is. */
  expiryUnit?: string;
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
  /**
   * T-INT-012. Both deliberately **not** given an eager default-parameter value (unlike `options`
   * above) — `PortalConfigRestClient`'s own default construction throws synchronously
   * (`MissingPortalRestTokenError`) when `PORTAL_REST_API_TOKEN` isn't set, and this constructor is
   * still called with a single argument by every pre-existing caller (`ProcessingModule`'s own
   * provider registration, and every existing test — none of which set that env var). Eagerly
   * constructing either dependency here would make *constructing this class at all* fail in exactly
   * those unmodified call sites. Instead: stay `undefined` until first actually needed, built
   * lazily by `getRestClient()`/`getChannelResolver()` below — the identical "construct only when a
   * caller actually reaches for it" discipline RAP's own T-INT-011 port already established.
   */
  private restClient?: PortalConfigRestClient;
  private channelResolver?: PortalConfigChannelResolverService;

  constructor(
    @Optional() options: CampaignConfigClientOptions = loadCampaignConfigClientOptions(),
    @Optional() restClient?: PortalConfigRestClient,
    @Optional() channelResolver?: PortalConfigChannelResolverService,
  ) {
    this.restClient = restClient;
    this.channelResolver = channelResolver;
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

  private getRestClient(): PortalConfigRestClient {
    if (!this.restClient) {
      this.restClient = new PortalConfigRestClient();
    }
    return this.restClient;
  }

  private getChannelResolver(): PortalConfigChannelResolverService {
    if (!this.channelResolver) {
      this.channelResolver = new PortalConfigChannelResolverService();
    }
    return this.channelResolver;
  }

  private isChannelEnabled(
    resolved: ResolvedPortalConfigChannel,
    channel: PortalConfigChannel,
  ): boolean {
    return channel === 'GRPC' ? resolved.grpcEnabled : resolved.restEnabled;
  }

  /**
   * T-INT-012. Resolves which channel(s) to attempt for one call, then runs the matching thunk —
   * `grpcCall`/`restCall` are never invoked speculatively; only the channel(s) this method actually
   * decides to attempt ever run (TC-2's own "zero gRPC calls made" when REST resolves and succeeds
   * depends on this — a naive `Promise.race`/always-call-both approach would violate it).
   */
  private async callWithTransportFallback<T>(
    context: PortalConfigChannelResolveContext,
    grpcCall: () => Promise<T>,
    restCall: () => Promise<T>,
  ): Promise<T> {
    let resolved: ResolvedPortalConfigChannel | undefined;
    try {
      resolved = await this.getChannelResolver().resolve(context);
    } catch (error) {
      this.logger.warn(
        'portal-config channel resolution failed — falling back to the pre-T-INT-012 gRPC-only ' +
          `behaviour for this call: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!resolved) {
      return grpcCall();
    }

    const runners: Record<PortalConfigChannel, () => Promise<T>> = {
      GRPC: grpcCall,
      REST: restCall,
    };

    const attempts: PortalConfigChannel[] = [];
    if (this.isChannelEnabled(resolved, resolved.primaryChannel)) {
      attempts.push(resolved.primaryChannel);
    }
    if (
      resolved.fallbackChannel !== resolved.primaryChannel &&
      this.isChannelEnabled(resolved, resolved.fallbackChannel)
    ) {
      attempts.push(resolved.fallbackChannel);
    }
    if (attempts.length === 0) {
      this.logger.warn(
        'portal-config resolved with both primary and fallback channels disabled — falling back ' +
          'to the pre-T-INT-012 gRPC-only behaviour for this call.',
      );
      return grpcCall();
    }

    let lastError: unknown;
    for (const channel of attempts) {
      try {
        return await runners[channel]();
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `portal-config channel ${channel} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw lastError;
  }

  private async listActiveCampaignsViaGrpc(
    tenantId: number,
    sections: readonly ConfigSectionName[],
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

  private async getCampaignConfigViaGrpc(
    tenantId: number,
    campaignCode: string,
    sections: readonly ConfigSectionName[],
    etag: string,
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

  async listActiveCampaigns(
    tenantId: number,
    sections: readonly ConfigSectionName[] = CAMPAIGN_CONFIG_SECTIONS,
  ): Promise<CampaignConfigListProto> {
    return this.callWithTransportFallback(
      { tenantId },
      () => this.listActiveCampaignsViaGrpc(tenantId, sections),
      () => this.getRestClient().listActiveCampaigns(tenantId, sections),
    );
  }

  async getCampaignConfig(
    tenantId: number,
    campaignCode: string,
    sections: readonly ConfigSectionName[] = CAMPAIGN_CONFIG_SECTIONS,
    etag = '',
  ): Promise<CampaignConfigProto> {
    return this.callWithTransportFallback(
      { tenantId, campaignCode },
      () => this.getCampaignConfigViaGrpc(tenantId, campaignCode, sections, etag),
      () => this.getRestClient().getCampaignConfig(tenantId, campaignCode, sections, etag),
    );
  }

  /** Implementation note 6 / TC-6: reclassifies `PERMISSION_DENIED` into a distinct, named,
   * clearly-logged error — every other gRPC failure (transient network errors, `UNAVAILABLE`,
   * a deadline exceeded) propagates unchanged, since those genuinely are generic
   * connection-shaped failures with no more specific diagnosis this client can add. Applied inside
   * `*ViaGrpc` itself (not in `callWithTransportFallback`) so this classification survives
   * T-INT-012's transport-fallback wrapping unchanged (this file's own header, "Resilience
   * contract"). */
  private classifyError(rpcName: string, tenantId: number, error: grpc.ServiceError): Error {
    if (error.code === grpc.status.PERMISSION_DENIED) {
      const classified = new PortalGrantNotProvisionedError(rpcName, tenantId, error);
      this.logger.error(classified.message);
      return classified;
    }
    return error;
  }

  async onModuleDestroy(): Promise<void> {
    this.client.close();
    // T-INT-012: only tear down `channelResolver`'s own `pg.Pool` if this instance actually built
    // one lazily — never close a resolver a caller injected and may still own elsewhere.
    if (this.channelResolver) {
      await this.channelResolver.onModuleDestroy();
    }
  }
}
