/**
 * T-RTS-020. `CampaignHierarchyClient` — this service's second consumer of the portal's existing
 * `ListActiveCampaigns`/`WatchCampaignConfig` gRPC feed (`ARCHITECTURE.md` §3,
 * `brain-storm/02-DATA-MODEL.md` §7), the same feed `realtime-activity-processing-service`
 * already consumes. Combines the thin gRPC transport wrapper AND the cold-start/invalidation
 * orchestration in one file: unlike RAP's own equivalent (split across `campaign-config.client.ts`
 * + `campaign-config-cache.service.ts`), this task's own "Files owned" list grants exactly one
 * client-shaped file plus a repository — no separate orchestration-service file — so both live
 * here. `CampaignHierarchyCacheRepository` (same file-scope owner) is the only thing this class
 * writes through; this class never touches Postgres directly.
 *
 * **Only `BASIC`/`MERCHANTS`/`TRACKERS` are ever requested** (`DEFAULT_CONFIG_SECTIONS`) — per
 * this task's own Objective: "no RULES, no REWARDS policy/value detail this service has no use
 * for and no grant to see", mirroring RAP's own "`ConfigSection` is an authorization boundary, not
 * a bandwidth optimization" discipline (`proto/campaign_config.proto`'s own header).
 *
 * **Never gates anything (R1).** Every failure path here — an unreachable portal at startup
 * (TC-3), a dropped `WatchCampaignConfig` stream, a malformed `PORTAL_CONFIG_TENANT_IDS` — is
 * caught, logged clearly, and never rethrown out of `onModuleInit`/the stream handlers. The worst
 * outcome this class can ever cause is a stale or empty `campaign_hierarchy_cache`, never a
 * process crash or a crash-loop.
 *
 * **`WatchCampaignConfig`, not polling** (implementation note 2): a dropped stream schedules a
 * simple reconnect after `PORTAL_GRPC_WATCH_RECONNECT_MS` rather than falling back to a polling
 * loop — the portal's own documented cache TTL (5 minutes) is *its* backstop, not something this
 * client needs to reimplement.
 *
 * Env vars read directly from `process.env`, not `ConfigService`/`src/config/config.schema.ts`:
 * that shared schema is outside this task's file scope, matching the exact precedent
 * `realtime-activity-processing-service/src/modules/campaign-cache/campaign-config.client.ts`'s
 * own header already set for the identical reason.
 *
 * See `proto/campaign_config.proto`'s own header for a real design finding this task surfaced but
 * did not silently work around: the portal's wire contract carries no campaign-level display
 * `name`, and no owner-contact field yet (`BACKLOG.md` RS-01) — `campaignName`/`ownerContact` are
 * always persisted as `null` today; see `persistCampaign` below.
 *
 * **T-INT-013 amendment.** Adds the REST fallback + config-driven resolver
 * `ARCHITECTURE.md` §4/`TRANSPORT-CONFIG.md` describe for this leg
 * (`reward_tracking.portal_config_channel_config`, migration `009`) on top of everything above —
 * per that task's own implementation note 2, **this class's public constructor and method
 * signatures do not change**: `campaign-cache.module.ts`'s own factory provider (out of this
 * task's "Files owned" scope) constructs this client via
 * `new CampaignHierarchyClient(loadCampaignHierarchyClientOptions(), repository)` and nothing
 * about that call site may need to change. `PortalConfigChannelResolverService` and
 * `PortalConfigRestClient` are therefore constructed **internally**, from their own
 * env-loaded/DB-loaded config, exactly the way this class's own gRPC client is already built
 * internally from `options` — not constructor-injected.
 *
 * **What actually changed**: `listActiveCampaigns`/`getCampaignConfig` (this file's "low-level
 * transport" section) are now resolver-aware orchestrators — they resolve the leg's configured
 * primary/fallback channel (`resolveChannel`) and try each enabled channel in order
 * (`callWithFallback`), REST via `PortalConfigRestClient`, gRPC via this class's own existing
 * `@grpc/grpc-js` wrapper (unchanged, renamed `*ViaGrpc`). `watchCampaignConfig`/`startWatching`
 * stay gRPC-only — REST has no streaming equivalent (`campaign-config-api.controller.ts`'s own
 * header: its `GetCampaignConfig` mirror only offers etag-based polling, not a push stream), and
 * this task's own TCs never test invalidation delivery over REST — gRPC remains the one live
 * change-notification channel regardless of which transport is primary for the warm/refetch path;
 * REST-primary deployments still get eventual consistency the same way every transport already
 * did before this task, via the portal's own 5-minute cache TTL as a backstop
 * (`loadCampaignHierarchyClientOptions`'s own header). Deliberate, disclosed interpretation of a
 * genuine ambiguity — see this task's own completion report's "Deviations" section.
 *
 * **Resolver-failure and REST-misconfiguration are both treated as "never gates" conditions**,
 * matching this class's own R1 contract above: a channel-resolution error (DB unreachable, table
 * missing, no GLOBAL row) logs a warning and defaults to `{primary: GRPC, fallback: REST}` — this
 * class's exact pre-T-INT-013 behavior — rather than throwing; a REST-client construction failure
 * (missing `PORTAL_CAMPAIGN_CONFIG_API_TOKEN`/`PORTAL_SERVICE_IDENTITY`) is caught once in the
 * constructor and simply makes every REST attempt fail closed (falls through to gRPC) rather than
 * crashing the process.
 */
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { CampaignHierarchyCacheWriter } from './campaign-hierarchy-cache.repository';
import {
  PortalConfigChannelResolverService,
  PortalConfigChannelResolutionError,
  type PortalConfigChannel,
  type ResolvedPortalConfigChannel,
} from './portal-config-channel-resolver.service';
import {
  PortalConfigRestClient,
  loadPortalConfigRestClientOptions,
} from './portal-config-rest.client';

export type ConfigSectionName = 'BASIC' | 'MERCHANTS' | 'TRACKERS' | 'RULES' | 'REWARDS' | 'CAPS';

/** The only sections this service ever requests or has a grant to see (this file's own header). */
export const DEFAULT_CONFIG_SECTIONS: readonly ConfigSectionName[] = Object.freeze([
  'BASIC',
  'MERCHANTS',
  'TRACKERS',
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
  // Always empty in practice — this service never requests RULES/REWARDS/CAPS (this file's own
  // header) — typed loosely since nothing here ever reads them.
  rules: unknown[];
  rewards: unknown[];
  caps: unknown[];
  etag: string;
  configHash: string;
  notModified: boolean;
  servedAt: string;
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

/** Shape of the dynamically-loaded `CampaignConfigService` grpc-js client this file wraps —
 * only the three RPCs this task actually calls. */
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
/** Matches the sibling services' own gRPC-fallback deadline convention — generous enough for a
 * real network hop, short enough that a genuinely unreachable portal fails one attempt within a
 * bounded time rather than hanging. */
export const DEFAULT_PORTAL_GRPC_TIMEOUT_MS = 5_000;
/** Delay before re-opening a dropped `WatchCampaignConfig` stream (this file's own header). */
export const DEFAULT_WATCH_RECONNECT_DELAY_MS = 5_000;

export interface CampaignHierarchyClientOptions {
  host: string;
  port: number;
  timeoutMs: number;
  reconnectDelayMs: number;
  tls?: {
    rootCerts: Buffer;
    clientCert: Buffer;
    clientKey: Buffer;
  };
}

/** `PORTAL_GRPC_HOST`/`PORTAL_GRPC_PORT` default to `localhost`/50051 (the portal's own
 * `GRPC_DEFAULT_PORT`) — overridable per environment. TLS material is optional; all three paths
 * must be set together or none are used (a partially-configured mTLS setup is a
 * misconfiguration, not a silent insecure fallback). This service's own `grpc_service_grants` row
 * (the certificate SAN naming the sections it's allowed) is a portal-side administrative action —
 * implementation note 1 — never something this code provisions. */
export function loadCampaignHierarchyClientOptions(): CampaignHierarchyClientOptions {
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

  const rawReconnectDelay = process.env.PORTAL_GRPC_WATCH_RECONNECT_MS?.trim();
  const reconnectDelayMs = rawReconnectDelay
    ? Number.parseInt(rawReconnectDelay, 10)
    : DEFAULT_WATCH_RECONNECT_DELAY_MS;
  if (!Number.isInteger(reconnectDelayMs) || reconnectDelayMs <= 0) {
    throw new Error(
      `Invalid PORTAL_GRPC_WATCH_RECONNECT_MS: "${rawReconnectDelay}" is not a positive integer`,
    );
  }

  const caPath = process.env.PORTAL_GRPC_TLS_CA_PATH?.trim();
  const certPath = process.env.PORTAL_GRPC_TLS_CERT_PATH?.trim();
  const keyPath = process.env.PORTAL_GRPC_TLS_KEY_PATH?.trim();

  if (!caPath && !certPath && !keyPath) {
    return { host, port, timeoutMs, reconnectDelayMs };
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
    reconnectDelayMs,
    tls: {
      rootCerts: readFileSync(caPath),
      clientCert: readFileSync(certPath),
      clientKey: readFileSync(keyPath),
    },
  };
}

/** `PORTAL_CONFIG_TENANT_IDS` — comma-separated tenant ids this instance caches hierarchy for.
 * Deliberately does NOT swallow a missing/malformed value into an empty list itself — the one
 * caller (`bootstrap`) decides what "no tenants configured" means for this service's own,
 * never-gates, never-crashes contract (R1, TC-3), so the failure is still loud in the log even
 * though it can never abort startup. */
export function resolveConfiguredTenantIds(): number[] {
  const raw = process.env.PORTAL_CONFIG_TENANT_IDS?.trim();
  if (!raw) {
    throw new Error(
      'PORTAL_CONFIG_TENANT_IDS is required (comma-separated tenant ids to cache campaign ' +
        'hierarchy for) — without it there is no tenant to call ListActiveCampaigns/' +
        'WatchCampaignConfig for.',
    );
  }
  const ids = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parsed = Number.parseInt(entry, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
          `Invalid PORTAL_CONFIG_TENANT_IDS entry "${entry}": must be a positive integer`,
        );
      }
      return parsed;
    });
  if (ids.length === 0) {
    throw new Error('PORTAL_CONFIG_TENANT_IDS must contain at least one tenant id');
  }
  return ids;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `campaign_config.proto` lives alongside this file (`./proto/`), inside this task's own file
 * scope (`src/modules/campaign-cache/**`) rather than at the project root the way
 * `realtime-activity-processing-service`'s own copy does. Known consequence, not an oversight:
 * this project has no `nest-cli.json` `assets` config to copy non-`.ts` files into `dist/` on
 * build (neither does RAP's — this repo-wide gap predates this task), so a production boot from
 * `dist/` needs that copy step added before this module is ever wired into `AppModule` (it isn't,
 * by this task — see `campaign-cache.module.ts`'s own header). Flagged in this task's completion
 * report rather than silently reaching outside this task's granted file scope to add one. */
function resolveProtoPath(): string {
  return join(__dirname, 'proto', 'campaign_config.proto');
}

function buildCredentials(options: CampaignHierarchyClientOptions): grpc.ChannelCredentials {
  if (!options.tls) {
    return grpc.credentials.createInsecure();
  }
  return grpc.credentials.createSsl(
    options.tls.rootCerts,
    options.tls.clientKey,
    options.tls.clientCert,
  );
}

@Injectable()
export class CampaignHierarchyClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampaignHierarchyClient.name);
  private readonly client: RawCampaignConfigServiceClient;
  private readonly timeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly activeStreams = new Map<number, grpc.ClientReadableStream<unknown>>();
  private readonly reconnectTimers = new Map<number, NodeJS.Timeout>();
  private destroyed = false;

  // T-INT-013 — constructed internally, not constructor-injected (this file's own header).
  private readonly channelResolver: PortalConfigChannelResolverService;
  private readonly restClient: PortalConfigRestClient | null;

  constructor(
    options: CampaignHierarchyClientOptions,
    private readonly repository: CampaignHierarchyCacheWriter,
  ) {
    this.timeoutMs = options.timeoutMs;
    this.reconnectDelayMs = options.reconnectDelayMs;

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

    this.channelResolver = new PortalConfigChannelResolverService();
    try {
      this.restClient = new PortalConfigRestClient(loadPortalConfigRestClientOptions());
    } catch (error) {
      // R1 / this file's own header: a REST-misconfiguration never gates this class — every REST
      // attempt below just fails closed (`restClient === null`) and falls through to gRPC.
      this.logger.warn(
        `portal-config REST transport unavailable (${describeError(error)}) — REST attempts will ` +
          'fail closed and fall back to GRPC whenever REST is selected as primary or fallback.',
      );
      this.restClient = null;
    }
  }

  private deadline(): grpc.CallOptions {
    return { deadline: Date.now() + this.timeoutMs };
  }

  // -------------------------------------------------------------------------------------------
  // Low-level transport (thin wrappers, no persistence).
  //
  // T-INT-013: `listActiveCampaigns`/`getCampaignConfig` are now resolver-aware orchestrators —
  // see `resolveChannel`/`callWithFallback` below. The original gRPC-only bodies are unchanged,
  // just renamed `*ViaGrpc`; `*ViaRest` are new. `watchCampaignConfig` stays gRPC-only (this
  // file's own header amendment on why).
  // -------------------------------------------------------------------------------------------

  async listActiveCampaigns(
    tenantId: number,
    sections: readonly ConfigSectionName[] = DEFAULT_CONFIG_SECTIONS,
  ): Promise<CampaignConfigListProto> {
    const resolved = await this.resolveChannel({ tenantId });
    return this.callWithFallback(
      resolved,
      () => this.listActiveCampaignsViaRest(tenantId, sections),
      () => this.listActiveCampaignsViaGrpc(tenantId, sections),
    );
  }

  async getCampaignConfig(
    tenantId: number,
    campaignCode: string,
    sections: readonly ConfigSectionName[] = DEFAULT_CONFIG_SECTIONS,
    etag = '',
  ): Promise<CampaignConfigProto> {
    const resolved = await this.resolveChannel({ tenantId, campaignCode });
    return this.callWithFallback(
      resolved,
      () => this.getCampaignConfigViaRest(tenantId, campaignCode, sections, etag),
      () => this.getCampaignConfigViaGrpc(tenantId, campaignCode, sections, etag),
    );
  }

  watchCampaignConfig(tenantId: number): grpc.ClientReadableStream<ConfigChangeEventProto> {
    return this.client.watchCampaignConfig({ tenantId }, new grpc.Metadata());
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

  private async listActiveCampaignsViaRest(
    tenantId: number,
    sections: readonly ConfigSectionName[],
  ): Promise<CampaignConfigListProto> {
    if (!this.restClient) {
      throw new Error('portal-config REST transport is not configured (see constructor warning)');
    }
    return this.restClient.listActiveCampaigns(tenantId, sections);
  }

  private async getCampaignConfigViaRest(
    tenantId: number,
    campaignCode: string,
    sections: readonly ConfigSectionName[],
    etag: string,
  ): Promise<CampaignConfigProto> {
    if (!this.restClient) {
      throw new Error('portal-config REST transport is not configured (see constructor warning)');
    }
    return this.restClient.getCampaignConfig(tenantId, campaignCode, sections, etag);
  }

  /**
   * Resolves which channel is primary/fallback for this call (`PortalConfigChannelResolverService`,
   * migration `009`). Never throws (R1): a resolution failure — DB unreachable, table missing, no
   * `GLOBAL` row — logs a warning and defaults to `{primary: GRPC, fallback: REST}`, this class's
   * exact pre-T-INT-013 behavior, so a misconfigured/un-migrated environment degrades to "acts like
   * this task never landed" rather than crashing.
   */
  private async resolveChannel(context: {
    tenantId?: number;
    campaignCode?: string;
  }): Promise<ResolvedPortalConfigChannel> {
    try {
      return await this.channelResolver.resolve(context);
    } catch (error) {
      const reason =
        error instanceof PortalConfigChannelResolutionError
          ? 'no portal_config_channel_config row resolved, not even GLOBAL'
          : describeError(error);
      this.logger.warn(
        `portal-config channel resolution failed (${reason}) — defaulting to GRPC primary / REST ` +
          "fallback, this class's own pre-T-INT-013 behavior.",
      );
      return {
        primaryChannel: 'GRPC',
        fallbackChannel: 'REST',
        restEnabled: true,
        grpcEnabled: true,
      };
    }
  }

  /**
   * Tries the resolved primary channel, then the resolved fallback (only if different and
   * enabled) — TC-2 (REST primary succeeds → the gRPC closure is never invoked, since this loop
   * only calls a channel's closure when that channel's own turn comes up), TC-3 (REST primary
   * fails → gRPC fallback attempted and succeeds). A channel `enabled: false` in the resolved
   * config is skipped with a warning rather than attempted.
   */
  private async callWithFallback<T>(
    resolved: ResolvedPortalConfigChannel,
    restCall: () => Promise<T>,
    grpcCall: () => Promise<T>,
  ): Promise<T> {
    const callFor = (channel: PortalConfigChannel): (() => Promise<T>) =>
      channel === 'REST' ? restCall : grpcCall;
    const isEnabled = (channel: PortalConfigChannel): boolean =>
      channel === 'REST' ? resolved.restEnabled : resolved.grpcEnabled;

    const attempts: PortalConfigChannel[] = [resolved.primaryChannel];
    if (resolved.fallbackChannel !== resolved.primaryChannel) {
      attempts.push(resolved.fallbackChannel);
    }

    let lastError: unknown;
    for (const channel of attempts) {
      if (!isEnabled(channel)) {
        this.logger.warn(`portal-config channel ${channel} is disabled by config — skipping.`);
        continue;
      }
      try {
        return await callFor(channel)();
      } catch (error) {
        lastError = error;
        this.logger.warn(`portal-config ${channel} attempt failed: ${describeError(error)}`);
      }
    }

    throw lastError ?? new Error('portal-config: no enabled transport available');
  }

  // -------------------------------------------------------------------------------------------
  // Orchestration: cold-start bulk warm + live invalidation (this task's own Objective/Scope).
  // -------------------------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    let tenantIds: number[];
    try {
      tenantIds = resolveConfiguredTenantIds();
    } catch (error) {
      // R1 / TC-3: a configuration problem is logged clearly but must never crash-loop this
      // service — campaign_hierarchy_cache is purely display data, never on any decision path.
      this.logger.warn(
        `campaign_hierarchy_cache will not be warmed: ${describeError(error)}. Cache stays empty ` +
          `until this is fixed.`,
      );
      return;
    }

    for (const tenantId of tenantIds) {
      const warmed = await this.warmTenant(tenantId);
      if (!warmed) {
        this.logger.warn(
          `campaign_hierarchy_cache for tenant ${tenantId} is booting empty/stale — the portal ` +
            `was unreachable at startup (TC-3). Watching for it to come back via ` +
            `WatchCampaignConfig.`,
        );
      }
    }

    for (const tenantId of tenantIds) {
      this.startWatching(tenantId);
    }
  }

  /**
   * Full bulk refresh for one tenant (`ListActiveCampaigns`) — this task's own cold-start path.
   * Returns `false` (never throws) on any portal failure (TC-3), so a caller looping over several
   * tenants keeps going rather than aborting the whole warm cycle for one unreachable tenant.
   */
  async warmTenant(tenantId: number): Promise<boolean> {
    let list: CampaignConfigListProto;
    try {
      list = await this.listActiveCampaigns(tenantId, DEFAULT_CONFIG_SECTIONS);
    } catch (error) {
      this.logger.warn(
        `ListActiveCampaigns failed for tenant ${tenantId}: ${describeError(error)}`,
      );
      return false;
    }

    const previousCodes = await this.repository.findCampaignCodesForTenant(tenantId);
    const seenCodes = new Set<string>();

    // Sequential per campaign — each upsert completes before the next starts, keeping ordering
    // predictable within one tenant's own warm cycle (small, config-sized loop, not per-transaction).
    for (const campaign of list.campaigns) {
      await this.persistCampaign(campaign);
      seenCodes.add(campaign.campaignCode);
    }

    for (const code of previousCodes) {
      if (!seenCodes.has(code)) {
        await this.repository.markInactive(tenantId, code);
      }
    }

    return true;
  }

  /**
   * Opens (or re-opens) the `WatchCampaignConfig` stream for one tenant (implementation note 2).
   * Never throws — a synchronous failure to open, a later `error`, or a graceful `end` from the
   * server all schedule a reconnect after `reconnectDelayMs` rather than propagating.
   */
  private startWatching(tenantId: number): void {
    if (this.destroyed) {
      return;
    }

    let stream: grpc.ClientReadableStream<ConfigChangeEventProto>;
    try {
      stream = this.watchCampaignConfig(tenantId);
    } catch (error) {
      this.logger.warn(
        `Failed to open WatchCampaignConfig for tenant ${tenantId}: ${describeError(error)}`,
      );
      this.scheduleReconnect(tenantId);
      return;
    }

    this.activeStreams.set(tenantId, stream as grpc.ClientReadableStream<unknown>);

    stream.on('data', (event: ConfigChangeEventProto) => {
      this.handleChangeEvent(tenantId, event).catch((error: unknown) => {
        this.logger.warn(
          `Failed to apply WatchCampaignConfig event for tenant ${tenantId}, campaign ` +
            `${event.campaignCode}: ${describeError(error)}`,
        );
      });
    });

    stream.on('error', (error: unknown) => {
      this.activeStreams.delete(tenantId);
      if (this.destroyed) {
        // A shutdown this class itself initiated (`onModuleDestroy`'s own `cancel()`) surfaces as
        // a `CANCELLED` error on this same stream — expected, not a real drop, and Node's
        // `EventEmitter` throws if an `'error'` event has no listener at all, so this handler
        // must stay attached (never `removeAllListeners()`) even though there is nothing to do.
        return;
      }
      this.logger.warn(
        `WatchCampaignConfig stream error for tenant ${tenantId}: ${describeError(error)} — ` +
          `reconnecting in ${this.reconnectDelayMs}ms.`,
      );
      this.scheduleReconnect(tenantId);
    });

    stream.on('end', () => {
      this.activeStreams.delete(tenantId);
      this.scheduleReconnect(tenantId);
    });
  }

  private scheduleReconnect(tenantId: number): void {
    if (this.destroyed) {
      return;
    }
    const existing = this.reconnectTimers.get(tenantId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => this.startWatching(tenantId), this.reconnectDelayMs);
    timer.unref();
    this.reconnectTimers.set(tenantId, timer);
  }

  /**
   * TC-2: a `WatchCampaignConfig` invalidation refreshes the one named campaign. `ENDED` needs no
   * extra round trip — the campaign is gone, so this just marks the existing row inactive
   * (`markInactive`); `UPDATED`/`PAUSED` re-fetch full detail via `GetCampaignConfig` so the
   * cached `hierarchy` reflects the new state, not just the bare event fields.
   */
  private async handleChangeEvent(tenantId: number, event: ConfigChangeEventProto): Promise<void> {
    if (event.changeType === 'ENDED') {
      await this.repository.markInactive(tenantId, event.campaignCode);
      return;
    }

    const campaign = await this.getCampaignConfig(
      tenantId,
      event.campaignCode,
      DEFAULT_CONFIG_SECTIONS,
    );
    await this.persistCampaign(campaign);
  }

  /**
   * Persists one campaign's snapshot into `campaign_hierarchy_cache`. `campaignName`/
   * `ownerContact` are always `null` today — see this file's own header and
   * `proto/campaign_config.proto`'s "Finding worth flagging": the portal's current wire contract
   * carries neither a campaign-level display name nor an owner-contact field.
   */
  private async persistCampaign(campaign: CampaignConfigProto): Promise<void> {
    await this.repository.upsert({
      tenantId: campaign.tenantId,
      campaignCode: campaign.campaignCode,
      campaignName: null,
      configVersion: campaign.configHash || campaign.etag || null,
      isActive: campaign.status === 'active',
      ownerContact: null,
      hierarchy: campaign,
    });
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    // T-INT-013: close the resolver's own `pg.Pool` too (this class's second real resource,
    // alongside the gRPC channel closed below). Fire-and-forget, not awaited — this method's own
    // signature stays synchronous (every existing call site, including the test spec, calls it
    // without `await`); a pool-close error here is logged, never thrown, matching this whole
    // class's "never gates" contract.
    this.channelResolver
      .close()
      .catch((error: unknown) =>
        this.logger.warn(`portal-config resolver pool close failed: ${describeError(error)}`),
      );
    for (const stream of this.activeStreams.values()) {
      // Listeners deliberately stay attached (never `removeAllListeners()`): grpc-js's own
      // `ClientReadableStream` throws an unhandled-error exception if an `'error'` event fires
      // with zero listeners, and `cancel()` below reliably fires exactly that. The `'error'`
      // handler's own `this.destroyed` check (set above) is what makes this a silent, expected
      // no-op instead of a spurious "reconnecting" log.
      stream.cancel();
    }
    this.activeStreams.clear();
    this.client.close();
  }
}
