/**
 * T-RAP-010. Thin gRPC client wrapper around the portal's `CampaignConfigService`
 * (`proto/campaign_config.proto`, this service's own client-side copy of
 * `portal/back-end/proto/campaign_config.v1.proto` — see that file's header). Pure transport
 * plumbing — (de)serialization and promisification only, no caching/indexing logic (that's
 * `CampaignConfigCacheService`'s job) and no business logic (R5's spirit applies here too, even
 * though R5 itself is about the ingestion transports).
 *
 * Auth (mTLS) is an operational/deployment concern, not a development one
 * (`04-CACHE-INVALIDATION.md` §4: "provisioning this service's own `grpc_service_grants` identity
 * ... is an operational/deployment action, not a development task"). This client supports it when
 * certificate material is configured (`PORTAL_GRPC_TLS_*`) and falls back to an insecure channel
 * otherwise — the shape every local/test/mock-portal environment in this task's own scope uses.
 *
 * Env vars read directly from `process.env`, not `ConfigService`/`src/config/config.schema.ts`:
 * that shared schema is outside this task's file scope (`src/config/**` is
 * `agent-rap-foundation`'s), matching the exact precedent
 * `promo-code-service/src/grpc/grpc-server.config.ts` already set for the same reason.
 *
 * **T-INT-011**: `listActiveCampaigns`/`getCampaignConfig` are no longer gRPC-only. Both now
 * resolve their transport at call time via `PortalConfigChannelResolverService`
 * (`portal-config-channel-resolver.service.ts`, table `portal_config_channel_config`, migration
 * `016`) and branch to either this file's own original gRPC call (renamed
 * `*ViaGrpc`, unchanged) or `PortalConfigRestClient` (`portal-config-rest.client.ts`, T-INT-010's
 * new REST mirror). **Every public method signature is unchanged** (implementation note 2) — every
 * existing caller (`CampaignConfigCacheModule`/`CampaignConfigCacheService`, and the tests listed
 * in this file's own header history) keeps working with zero changes on their side. `watchCampaignConfig`
 * itself is untouched (implementation note 3: no REST equivalent exists for the server-streaming
 * push; `WatchStreamConsumer`'s caller-side fallback to `ReconciliationPollerService`'s existing
 * 5-minute poll — which itself goes through the now-transport-resolved `listActiveCampaigns` above
 * — is what actually degrades gracefully when the resolved primary is REST, per that note's own
 * "confirm this is already sufficient" instruction; see this task's own completion report).
 *
 * **Resilience contract, deliberately conservative**: if `PortalConfigChannelResolverService`
 * itself fails to resolve (e.g. the DB is unreachable, or `portal_config_channel_config` doesn't
 * exist yet in an environment that hasn't run migration `016`), this client logs a warning and
 * falls straight through to the original, pre-T-INT-011 gRPC-only call — never a hard failure for
 * a resolution problem this class didn't have before this task. Once a channel *is* resolved, a
 * disabled channel (`restEnabled`/`grpcEnabled` false) is simply skipped, never attempted; if the
 * enabled primary fails, the enabled fallback is tried next; if every attempted channel fails, the
 * last error is rethrown — TC-5's own "raises/degrades exactly as it already does today on gRPC
 * failure" contract.
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

export type ConfigSectionName = 'BASIC' | 'MERCHANTS' | 'TRACKERS' | 'RULES' | 'REWARDS' | 'CAPS';

/** Every grantable section this service ever needs — `ARCHITECTURE.md` §10 / task implementation note 1. */
export const ALL_CONFIG_SECTIONS: readonly ConfigSectionName[] = Object.freeze([
  'BASIC',
  'MERCHANTS',
  'TRACKERS',
  'RULES',
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

export interface BoundRuleProto {
  ruleId: number;
  ruleVersionId: number;
  versionNo: number;
  ruleCode: string;
  expression: string;
  parametersJson: string;
  boundValuesJson: string;
  trackerComponentId: number;
  status: string;
}

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
  rules: BoundRuleProto[];
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

export interface ConfigChangeEventProto {
  campaignId: number;
  campaignCode: string;
  tenantId: number;
  changeType: 'CHANGE_TYPE_UNSPECIFIED' | 'UPDATED' | 'PAUSED' | 'ENDED';
  etag: string;
  occurredAt: string;
}

/** Shape of the dynamically-loaded `CampaignConfigService` grpc-js client this file wraps. */
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
  watchCampaignConfig(
    request: unknown,
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<ConfigChangeEventProto>;
}

export const DEFAULT_PORTAL_GRPC_PORT = 50051;
/** Matches `promo-code-service`'s own gRPC-fallback deadline convention (T-PC's own client code) —
 * generous enough for a real network hop, short enough that a genuinely unreachable portal fails
 * a cold-start attempt within a bounded time rather than hanging the whole boot sequence. */
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

/** `PORTAL_GRPC_HOST`/`PORTAL_GRPC_PORT` default to `localhost`/50051 (the portal's own
 * `GRPC_DEFAULT_PORT`, `portal/back-end/src/grpc/grpc.constants.ts`) — overridable per
 * environment. TLS material is optional; all three paths must be set together or none are used
 * (a partially-configured mTLS setup is a misconfiguration, not a silent insecure fallback). */
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
 * (`ARCHITECTURE.md` §10: "each service instance ... opens its own stream at startup and keeps
 * it open for the life of the process" — this client is what that stream, and every unary call,
 * goes through).
 */
@Injectable()
export class CampaignConfigClient implements OnModuleDestroy {
  private readonly logger = new Logger(CampaignConfigClient.name);
  private readonly client: RawCampaignConfigServiceClient;
  private readonly timeoutMs: number;

  /**
   * T-INT-011. Both deliberately **not** given an eager default-parameter value (unlike `options`
   * above) — `PortalConfigRestClient`'s own default construction throws synchronously
   * (`MissingPortalRestTokenError`) when `PORTAL_REST_API_TOKEN` isn't set, and this constructor is
   * still called with a single argument by every pre-existing caller (`campaign-config-cache.module.ts`'s
   * own factory, and every existing test — none of which set that env var). Eagerly constructing
   * either dependency here would make *constructing this class at all* fail in exactly those
   * unmodified call sites. Instead: stay `undefined` until first actually needed, built lazily by
   * `getRestClient()`/`getChannelResolver()` below, the same "construct only when a caller actually
   * reaches for it" discipline `grpc-server.main.ts`'s own optional-transport gating already uses
   * elsewhere in this service.
   */
  private restClient?: PortalConfigRestClient;
  private channelResolver?: PortalConfigChannelResolverService;

  constructor(
    options: CampaignConfigClientOptions = loadCampaignConfigClientOptions(),
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
   * T-INT-011. Resolves which channel(s) to attempt for one call, then runs the matching thunk —
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
        'portal-config channel resolution failed — falling back to the pre-T-INT-011 gRPC-only ' +
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
          'to the pre-T-INT-011 gRPC-only behaviour for this call.',
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
            reject(error);
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
            reject(error);
            return;
          }
          resolve(response);
        },
      );
    });
  }

  async listActiveCampaigns(
    tenantId: number,
    sections: readonly ConfigSectionName[] = ALL_CONFIG_SECTIONS,
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
    sections: readonly ConfigSectionName[] = ALL_CONFIG_SECTIONS,
    etag = '',
  ): Promise<CampaignConfigProto> {
    return this.callWithTransportFallback(
      { tenantId, campaignCode },
      () => this.getCampaignConfigViaGrpc(tenantId, campaignCode, sections, etag),
      () => this.getRestClient().getCampaignConfig(tenantId, campaignCode, sections, etag),
    );
  }

  /**
   * Server-streaming — T-RAP-011's own concern to consume (Objective/Scope "Out": this task only
   * builds the stub). Exposed here, not there, because the underlying grpc-js client instance
   * (and its one long-lived channel) is owned by this class.
   */
  watchCampaignConfig(tenantId: number): grpc.ClientReadableStream<ConfigChangeEventProto> {
    return this.client.watchCampaignConfig({ tenantId }, new grpc.Metadata());
  }

  async onModuleDestroy(): Promise<void> {
    this.client.close();
    // T-INT-011: only tear down `channelResolver`'s own `pg.Pool` if this instance actually built
    // one lazily — never close a resolver a caller injected and may still own elsewhere.
    if (this.channelResolver) {
      await this.channelResolver.onModuleDestroy();
    }
  }
}
