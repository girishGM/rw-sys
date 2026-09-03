/**
 * T-RAP-033. `on_breach = 'pause_campaign'`'s own client call: the portal's existing
 * `POST /internal/v1/campaigns/:id/budget-breach` (`project-plan/09-INTEGRATION.md` §7a,
 * `01-DATABASE.md` §6) — the one portal mutation this service ever performs, and only for this one
 * narrow case. Served on the *same* mTLS internal listener as `CampaignConfigService`
 * (`portal/back-end/src/grpc/internal-service.bootstrap.ts` wires both the gRPC service and this
 * REST route onto one `node:http2` `createSecureServer({ allowHTTP1: true, ... })` listener —
 * `portal/back-end/src/grpc/wire/grpc-http2.server.ts`), so this client reuses the exact same
 * `PORTAL_GRPC_HOST`/`PORTAL_GRPC_PORT`/`PORTAL_GRPC_TLS_*` configuration
 * `CampaignConfigClient` (T-RAP-010) already resolves (`loadCampaignConfigClientOptions`,
 * imported — not edited — from `campaign-cache/campaign-config.client.ts`), over plain HTTPS (the
 * listener's own `allowHTTP1` compatibility layer) when TLS material is configured, never gRPC for
 * the breach report itself. When no TLS material is configured (`options.tls` unset), this falls
 * back to plain `node:http` — the same "local/test/mock-portal environment" precedent
 * `CampaignConfigClient`'s own `grpc.credentials.createInsecure()` fallback already sets: `node:https`
 * cannot speak to a genuinely TLS-less mock server at all (a bare `rejectUnauthorized: false` still
 * requires a TLS handshake to complete), so without this fallback every local/CI run lacking real
 * certificates would be unable to exercise this client at all, gRPC-side precedent notwithstanding.
 *
 * **`capId` resolution — a genuine gap this task found, resolved without touching another task's
 * files.** The cached `CampaignConfig.caps` (`CampaignCapProto`, `campaign-config.client.ts`)
 * carries no numeric id — unlike `BudgetStatusEntry.cap_id` on the portal's separate
 * `GetBudgetStatus` RPC. This service's own client-side proto mirror
 * (`proto/campaign_config.proto`, owned by `agent-rap-cache`) already includes `GetBudgetStatus`
 * in full — per that file's own header — "so a later Wave 3 task doesn't need to touch this file
 * ... just to add a method this contract already documents." This file is that later task: it
 * opens its own small, additional gRPC channel (never editing `campaign-cache/**`, R10) purely to
 * resolve `capId` values, matched back to a cached `CampaignCapProto` by the same discriminating
 * fields `BudgetStatusEntry` exposes (`cap_class`/`scope_level`/`scope_ref_id`/`period_type`/
 * `unit_type`/`unit_code` — not `period_value`/window times/`reward_type`, which
 * `BudgetStatusEntry` does not carry). An ambiguous match (more than one candidate on those six
 * fields) is treated as unresolved rather than guessed at: a wrong `capId` would silently corrupt
 * the portal's own audit trail (`09-INTEGRATION.md` §7a: "Audited ... `capId` ... in `detail`" —
 * a human reading it must be able to trust it), which is worse than skipping the notification —
 * the local cap denial/`activity_logs.error` outcome stands either way (implementation note 6).
 * Results are cached per campaign with a short TTL; this whole path is explicitly best-effort, so
 * a stale/failed resolution degrades to "no portal notification sent, logged" rather than blocking
 * anything.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  loadCampaignConfigClientOptions,
  type CampaignCapProto,
  type CampaignConfigClientOptions,
} from '@/modules/campaign-cache/campaign-config.client';

export interface BudgetBreachReport {
  tenantId: number;
  campaignId: number;
  campaignCode: string;
  cap: CampaignCapProto;
  observedTotal: string;
  breachedAt: Date;
}

interface RawBudgetStatusEntry {
  capId: number;
  capClass: string;
  scopeLevel: string;
  scopeRefId: number;
  periodType: string;
  unitType: string;
  unitCode: string;
}

interface RawBudgetStatusResponse {
  campaignId: number;
  servedAt: string;
  entries: RawBudgetStatusEntry[];
}

interface RawCampaignConfigServiceClient extends grpc.Client {
  getBudgetStatus(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: RawBudgetStatusResponse) => void,
  ): grpc.ClientUnaryCall;
}

/** Matches the reconciliation-poll TTL convention (`04-CACHE-INVALIDATION.md` §3) — this path is
 * a best-effort lookup, not a correctness boundary, so a short cache is fine. */
const CAP_ID_CACHE_TTL_MS = 5 * 60 * 1000;
/** This task's own interim retry convention (implementation note 6 asks to reuse "the same
 * backoff convention as T-RAP-034's dispatch tiers" — T-RAP-034 does not exist yet to define one,
 * flagged in the completion report). Fixed exponential backoff, capped at 3 attempts: generous
 * enough to ride out a transient blip, bounded enough to never meaningfully delay the caller,
 * which only awaits this after its own transaction has already committed the local denial. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function matchesBudgetStatusEntry(cap: CampaignCapProto, entry: RawBudgetStatusEntry): boolean {
  return (
    cap.capClass === entry.capClass &&
    cap.scopeLevel === entry.scopeLevel &&
    cap.scopeRefId === entry.scopeRefId &&
    cap.periodType === entry.periodType &&
    cap.unitType === entry.unitType &&
    cap.unitCode === entry.unitCode
  );
}

@Injectable()
export class BudgetBreachCallbackClient implements OnModuleDestroy {
  private readonly logger = new Logger(BudgetBreachCallbackClient.name);
  private readonly options: CampaignConfigClientOptions;
  private grpcClient: RawCampaignConfigServiceClient | null = null;
  private readonly capIdCache = new Map<
    string,
    { entries: RawBudgetStatusEntry[]; fetchedAt: number }
  >();

  constructor(options: CampaignConfigClientOptions = loadCampaignConfigClientOptions()) {
    this.options = options;
  }

  private client(): RawCampaignConfigServiceClient {
    if (this.grpcClient !== null) {
      return this.grpcClient;
    }
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
    this.grpcClient = new ServiceCtor(
      `${this.options.host}:${this.options.port}`,
      buildCredentials(this.options),
    ) as RawCampaignConfigServiceClient;
    return this.grpcClient;
  }

  private async fetchBudgetStatusEntries(
    tenantId: number,
    campaignCode: string,
  ): Promise<RawBudgetStatusEntry[]> {
    const cacheKey = `${tenantId}:${campaignCode}`;
    const cached = this.capIdCache.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.fetchedAt < CAP_ID_CACHE_TTL_MS) {
      return cached.entries;
    }
    const entries = await new Promise<RawBudgetStatusEntry[]>((resolve, reject) => {
      this.client().getBudgetStatus(
        { tenantId, campaignCode },
        new grpc.Metadata(),
        { deadline: Date.now() + this.options.timeoutMs },
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(response.entries ?? []);
        },
      );
    });
    this.capIdCache.set(cacheKey, { entries, fetchedAt: Date.now() });
    return entries;
  }

  /** `null` when no unambiguous `capId` can be resolved — logged by the caller, never thrown, per
   * this file's own header (a wrong guess would corrupt the audit trail; a missing notification
   * does not). */
  private async resolveCapId(
    tenantId: number,
    campaignCode: string,
    cap: CampaignCapProto,
  ): Promise<number | null> {
    const entries = await this.fetchBudgetStatusEntries(tenantId, campaignCode);
    const matches = entries.filter((entry) => matchesBudgetStatusEntry(cap, entry));
    if (matches.length !== 1) {
      this.logger.warn(
        `Could not uniquely resolve capId for campaign "${campaignCode}" cap ` +
          `(${cap.capClass}/${cap.scopeLevel}/${cap.scopeRefId}/${cap.periodType}/` +
          `${cap.unitType}/${cap.unitCode}): ${matches.length} candidate(s) from GetBudgetStatus.`,
      );
      return null;
    }
    return matches[0].capId;
  }

  /**
   * Best-effort — retried up to `MAX_ATTEMPTS` times, then throws so the caller
   * (`CapEnforcementService`) can log-and-continue exactly as implementation note 6 requires:
   * "a failure here must never roll back this transaction's own cap-reservation/
   * `activity_logs.error` outcome — the local breach record and denial stand regardless of
   * whether the portal callback itself succeeds." This method never mutates any state of its own
   * beyond the portal call, so it is safe to call again on a later retry with no local
   * side-effects to undo.
   */
  async reportBreach(report: BudgetBreachReport): Promise<void> {
    const capId = await this.resolveCapId(report.tenantId, report.campaignCode, report.cap);
    if (capId === null) {
      throw new Error(
        `Cannot report budget breach for campaign "${report.campaignCode}": no unambiguous capId ` +
          "resolved (see this file's own resolveCapId header — a guess is deliberately refused).",
      );
    }

    const body = JSON.stringify({
      capId,
      breachedAt: report.breachedAt.toISOString(),
      observedTotal: report.observedTotal,
    });

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.postBudgetBreach(report.campaignId, body);
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `budget-breach callback attempt ${attempt}/${MAX_ATTEMPTS} failed for campaign ` +
            `${report.campaignId}: ${(error as Error).message}`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private postBudgetBreach(campaignId: number, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tls = this.options.tls;
      const path = `/internal/v1/campaigns/${campaignId}/budget-breach`;
      const requestOptions = {
        host: this.options.host,
        port: this.options.port,
        path,
        method: 'POST',
        timeout: this.options.timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      };
      // `node:https` cannot reach a genuinely TLS-less endpoint at all (this file's own header) —
      // `node:http` is the local/test/mock-portal fallback, mirroring `buildCredentials`'s own
      // `grpc.credentials.createInsecure()` precedent for the gRPC half of this same client.
      const request =
        tls === undefined
          ? http.request(requestOptions, handleResponse)
          : https.request(
              { ...requestOptions, ca: tls.rootCerts, cert: tls.clientCert, key: tls.clientKey },
              handleResponse,
            );

      function handleResponse(response: http.IncomingMessage): void {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve();
            return;
          }
          reject(
            new Error(
              `budget-breach callback returned HTTP ${status}: ` +
                Buffer.concat(chunks).toString('utf8'),
            ),
          );
        });
      }

      request.on('timeout', () => request.destroy(new Error('budget-breach callback timed out')));
      request.on('error', reject);
      request.write(body);
      request.end();
    });
  }

  onModuleDestroy(): void {
    this.grpcClient?.close();
  }
}
