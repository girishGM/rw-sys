/**
 * T-RAP-034. Thin gRPC client wrapper around `RewardIngestService.SubmitRewardEntry`
 * (`proto/reward_ingest.proto`, this task's own client-side contract — see that file's header),
 * the tier-2 dispatch fallback (`05-PROCESSING-PIPELINE.md` §7 point 2). Pure transport plumbing —
 * (de)serialization and promisification only, no retry/backoff/tier-fallthrough logic (that's
 * `OutboxPublisherService`/`RewardDispatchRetryWorker`'s job, R5's spirit applied to this client the
 * same way it applies to the two real transport adapters).
 *
 * Same insecure-channel-when-no-TLS-material-configured precedent `campaign-config.client.ts`
 * (T-RAP-010) already established, reused here rather than imported (that file lives in a
 * different task's own file scope, `src/modules/campaign-cache/**`, R10) — `reward-redemption-service`
 * does not exist anywhere in this repo (`03-GRPC-CONTRACT.md` §3), so in every environment this
 * task's own test suite runs in, this client either talks to a local test double or fails closed,
 * exactly as that section specifies ("expected to fail closed and fall through to
 * `reward_dispatch_retry` ... in any environment where `reward-redemption-service` isn't actually
 * running").
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const DEFAULT_REWARD_REDEMPTION_GRPC_PORT = 50061;
/** Generous enough for a real network hop, short enough that an unreachable
 * `reward-redemption-service` fails a tier-2 attempt within a bounded time rather than stalling a
 * dispatch cycle — same convention `campaign-config.client.ts`'s own
 * `DEFAULT_PORTAL_GRPC_TIMEOUT_MS` documents. */
export const DEFAULT_REWARD_REDEMPTION_GRPC_TIMEOUT_MS = 5_000;

export interface RewardGrpcFallbackClientOptions {
  host: string;
  port: number;
  timeoutMs: number;
  tls?: {
    rootCerts: Buffer;
    clientCert: Buffer;
    clientKey: Buffer;
  };
}

/** `REWARD_REDEMPTION_GRPC_HOST`/`REWARD_REDEMPTION_GRPC_PORT` — deliberately a distinct env-var
 * prefix from `PORTAL_GRPC_*` (`campaign-config.client.ts`): this is a different remote service
 * entirely, not the portal, and must never accidentally inherit the portal's own host/port/TLS
 * material if only one of the two happens to be configured in a given environment. */
export function loadRewardGrpcFallbackClientOptions(): RewardGrpcFallbackClientOptions {
  const host = process.env.REWARD_REDEMPTION_GRPC_HOST?.trim() || 'localhost';
  const rawPort = process.env.REWARD_REDEMPTION_GRPC_PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_REWARD_REDEMPTION_GRPC_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid REWARD_REDEMPTION_GRPC_PORT: "${rawPort}" is not a positive integer`);
  }

  const rawTimeout = process.env.REWARD_REDEMPTION_GRPC_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout
    ? Number.parseInt(rawTimeout, 10)
    : DEFAULT_REWARD_REDEMPTION_GRPC_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `Invalid REWARD_REDEMPTION_GRPC_TIMEOUT_MS: "${rawTimeout}" is not a positive integer`,
    );
  }

  const caPath = process.env.REWARD_REDEMPTION_GRPC_TLS_CA_PATH?.trim();
  const certPath = process.env.REWARD_REDEMPTION_GRPC_TLS_CERT_PATH?.trim();
  const keyPath = process.env.REWARD_REDEMPTION_GRPC_TLS_KEY_PATH?.trim();
  if (!caPath && !certPath && !keyPath) {
    return { host, port, timeoutMs };
  }
  if (!caPath || !certPath || !keyPath) {
    throw new Error(
      'Invalid gRPC client TLS configuration: REWARD_REDEMPTION_GRPC_TLS_CA_PATH, ' +
        'REWARD_REDEMPTION_GRPC_TLS_CERT_PATH and REWARD_REDEMPTION_GRPC_TLS_KEY_PATH must all be ' +
        'set together, or none of them (got a partial set)',
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

/** Proto-mirrored input (camelCase, `proto/reward_ingest.proto`'s own `RewardEntry` message) — the
 * caller (`OutboxPublisherService`/`RewardDispatchRetryWorker`) is responsible for having already
 * decrypted `customerId` at this exact call boundary (R4), never earlier. */
export interface RewardEntryGrpcPayload {
  id: string;
  correlationId: string;
  tenantId: number;
  customerId: string;
  customerIdType: string;
  activityPerformedDate: string;
  transactionType: string;
  activityCode: string;
  activityType: string;
  activityCategory: string;
  activityValue: string;
  activityValueUnit: string;
  channel: string;
  activityPerformedEnv: string;
  activityName: string;
  campaignCode: string;
  trackerCode: string;
  trackerComponentCode: string;
  merchantCode: string;
  rewardCode: string;
  rewardCategory: string;
  rewardValue: string;
  rewardValueUnit: string;
  rewardEntryDate: string;
  completionCycle: number;
}

export interface SubmitRewardEntryAck {
  rewardEntryId: string;
  status: string;
}

/** Shared by `outbox-publisher.service.ts` (tier 2) and `reward-dispatch-retry.worker.ts` (tier 3,
 * "Kafka, then gRPC, same order") — both build this exact shape from a
 * `RewardEntryOutboxPayload`/`RewardEntryRow` plus the one already-decrypted `customerId` (R4).
 * `?? ''` on the three genuinely-optional source fields matches proto3's own "empty string means
 * absent" convention, same as `activity_ingest.proto`'s own `transaction_type`/`activity_code`. */
export function toRewardEntryGrpcPayload(
  source: {
    id: string;
    correlationId: string;
    tenantId: number;
    customerIdType: string;
    activityPerformedDate: string;
    transactionType: string | null;
    activityCode: string | null;
    activityType: string;
    activityCategory: string;
    activityValue: string;
    activityValueUnit: string;
    channel: string;
    activityPerformedEnv: string;
    activityName: string;
    campaignCode: string;
    trackerCode: string;
    trackerComponentCode: string;
    merchantCode: string | null;
    rewardCode: string;
    rewardCategory: string;
    rewardValue: string;
    rewardValueUnit: string;
    rewardEntryDate: string;
    completionCycle: number;
  },
  customerId: string,
): RewardEntryGrpcPayload {
  return {
    id: source.id,
    correlationId: source.correlationId,
    tenantId: source.tenantId,
    customerId,
    customerIdType: source.customerIdType,
    activityPerformedDate: source.activityPerformedDate,
    transactionType: source.transactionType ?? '',
    activityCode: source.activityCode ?? '',
    activityType: source.activityType,
    activityCategory: source.activityCategory,
    activityValue: source.activityValue,
    activityValueUnit: source.activityValueUnit,
    channel: source.channel,
    activityPerformedEnv: source.activityPerformedEnv,
    activityName: source.activityName,
    campaignCode: source.campaignCode,
    trackerCode: source.trackerCode,
    trackerComponentCode: source.trackerComponentCode,
    merchantCode: source.merchantCode ?? '',
    rewardCode: source.rewardCode,
    rewardCategory: source.rewardCategory,
    rewardValue: source.rewardValue,
    rewardValueUnit: source.rewardValueUnit,
    rewardEntryDate: source.rewardEntryDate,
    completionCycle: source.completionCycle,
  };
}

interface RawRewardIngestServiceClient extends grpc.Client {
  submitRewardEntry(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: SubmitRewardEntryAck) => void,
  ): grpc.ClientUnaryCall;
}

function resolveProtoPath(): string {
  return join(__dirname, '..', '..', '..', 'proto', 'reward_ingest.proto');
}

function buildCredentials(options: RewardGrpcFallbackClientOptions): grpc.ChannelCredentials {
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
export class RewardGrpcFallbackClient implements OnModuleDestroy {
  private readonly logger = new Logger(RewardGrpcFallbackClient.name);
  private readonly timeoutMs: number;
  private readonly client: RawRewardIngestServiceClient;

  constructor(options: RewardGrpcFallbackClientOptions = loadRewardGrpcFallbackClientOptions()) {
    this.timeoutMs = options.timeoutMs;
    const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      rewardrap: {
        reward: { v1: { RewardIngestService: new (...args: unknown[]) => grpc.Client } };
      };
    };
    const ServiceCtor = proto.rewardrap.reward.v1.RewardIngestService;
    this.client = new ServiceCtor(
      `${options.host}:${options.port}`,
      buildCredentials(options),
    ) as RawRewardIngestServiceClient;
  }

  /** TC-3/TC-4/TC-5: throws on any transport/deadline failure — the caller decides what that means
   * (retry, tier-fallthrough, `reward_dispatch_retry` write), never this method. */
  async submitRewardEntry(payload: RewardEntryGrpcPayload): Promise<SubmitRewardEntryAck> {
    return new Promise((resolve, reject) => {
      this.client.submitRewardEntry(
        payload,
        new grpc.Metadata(),
        { deadline: Date.now() + this.timeoutMs },
        (error, response) => {
          if (error) {
            this.logger.warn(
              `SubmitRewardEntry failed for reward_entry ${payload.id}: ${error.message}`,
            );
            reject(error);
            return;
          }
          resolve(response);
        },
      );
    });
  }

  onModuleDestroy(): void {
    this.client.close();
  }
}
