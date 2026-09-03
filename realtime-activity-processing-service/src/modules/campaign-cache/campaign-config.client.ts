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
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

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

  constructor(options: CampaignConfigClientOptions = loadCampaignConfigClientOptions()) {
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
    sections: readonly ConfigSectionName[] = ALL_CONFIG_SECTIONS,
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

  async getCampaignConfig(
    tenantId: number,
    campaignCode: string,
    sections: readonly ConfigSectionName[] = ALL_CONFIG_SECTIONS,
    etag = '',
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

  /**
   * Server-streaming — T-RAP-011's own concern to consume (Objective/Scope "Out": this task only
   * builds the stub). Exposed here, not there, because the underlying grpc-js client instance
   * (and its one long-lived channel) is owned by this class.
   */
  watchCampaignConfig(tenantId: number): grpc.ClientReadableStream<ConfigChangeEventProto> {
    return this.client.watchCampaignConfig({ tenantId }, new grpc.Metadata());
  }

  onModuleDestroy(): void {
    this.client.close();
  }
}
