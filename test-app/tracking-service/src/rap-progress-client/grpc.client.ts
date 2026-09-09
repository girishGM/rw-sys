/**
 * T-INT-021 — thin gRPC client wrapping RAP's real `ProgressQueryService` (T-INT-020,
 * `../proto/progress_query.v1.proto` — a local copy, see that file's own header for why),
 * registered on the **same** gRPC server/port as `ActivityIngestService` (`rap-client/client.ts`'s
 * own `DEFAULT_RAP_GRPC_PORT`). Pure transport plumbing only, mirroring
 * `rap-client/client.ts`'s own split: this class does the call and throws typed errors
 * (`errors.ts`) on failure.
 *
 * ## mTLS
 *
 * RAP's gRPC server requires a CA-signed client certificate at the TLS handshake itself for
 * *every* RPC on this listener, including `ProgressQueryService` — confirmed by direct read of
 * `grpc-server.bootstrap.ts` (`ServerCredentials.createSsl(..., checkClientCertificate: true)`
 * applies to the whole server, not per-service). `ProgressQueryController` itself does not check
 * the caller's identity against RAP's own service allowlist (`MtlsGuard` is not applied to it —
 * see that controller's own header), but the connection still cannot complete without *some*
 * CA-signed certificate. Same optional-all-or-none TLS config shape `rap-client/from-env.ts`
 * already established, reused here rather than reinvented.
 */
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { RapProgressRequestError, RapProgressUnreachableError } from './errors';
import { signProgressApiToken } from './token';
import type {
  GetCampaignProgressParams,
  GetTrackerProgressParams,
  RapCampaignProgress,
  RapProgressReader,
  RapTrackerProgress,
} from './types';

export const DEFAULT_RAP_PROGRESS_GRPC_PORT = 50071;
export const DEFAULT_RAP_PROGRESS_GRPC_TIMEOUT_MS = 3_000;

export interface RapProgressGrpcClientOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly secret: Buffer;
  readonly tokenTtlSeconds?: number;
  readonly tls?: {
    readonly rootCerts: Buffer;
    readonly clientCert: Buffer;
    readonly clientKey: Buffer;
  };
  readonly now?: () => Date;
}

interface ComponentProgressProto {
  componentCode: string;
  currentCount: number;
  requiredCount: number;
  isCompleted: boolean;
}

interface TrackerProgressViewProto {
  trackerCode: string;
  completionLogic: string;
  isCompleted: boolean;
  completedAt: string;
  componentsRequiredCount: number;
  componentsCompletedCount: number;
  components: ComponentProgressProto[];
}

interface CampaignProgressResponseProto {
  customerId: string;
  campaignCode: string;
  trackers: TrackerProgressViewProto[];
}

type TrackerProgressResponseProto = TrackerProgressViewProto & {
  customerId: string;
  campaignCode: string;
};

/** Shape of the dynamically-loaded `ProgressQueryService` grpc-js client this file wraps, and the
 * one seam a test injects a fake through instead of opening a real channel — same pattern
 * `rap-client/client.ts`'s own `RawActivityIngestServiceClient` establishes. */
export interface RawProgressQueryServiceClient {
  getCampaignProgress(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: CampaignProgressResponseProto) => void,
  ): unknown;
  getTrackerProgress(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: TrackerProgressResponseProto) => void,
  ): unknown;
  close(): void;
}

function resolveProtoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'progress_query.v1.proto');
}

function buildCredentials(options: RapProgressGrpcClientOptions): grpc.ChannelCredentials {
  if (!options.tls) return grpc.credentials.createInsecure();
  return grpc.credentials.createSsl(
    options.tls.rootCerts,
    options.tls.clientKey,
    options.tls.clientCert,
  );
}

export function buildRawProgressQueryClient(
  options: RapProgressGrpcClientOptions,
): RawProgressQueryServiceClient {
  const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    rewardrap: {
      progress: { v1: { ProgressQueryService: new (...args: unknown[]) => grpc.Client } };
    };
  };
  const ServiceCtor = proto.rewardrap.progress.v1.ProgressQueryService;
  return new ServiceCtor(
    `${options.host}:${options.port}`,
    buildCredentials(options),
  ) as unknown as RawProgressQueryServiceClient;
}

const DEFAULT_TOKEN_TTL_SECONDS = 300;

export class RapProgressGrpcClient implements RapProgressReader {
  private readonly client: RawProgressQueryServiceClient;
  private readonly timeoutMs: number;
  private readonly target: string;
  private readonly secret: Buffer;
  private readonly tokenTtlSeconds: number;
  private readonly now: () => Date;

  constructor(
    options: RapProgressGrpcClientOptions,
    rawClientOverride?: RawProgressQueryServiceClient,
  ) {
    this.timeoutMs = options.timeoutMs;
    this.target = `${options.host}:${options.port}`;
    this.secret = options.secret;
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    this.now = options.now ?? (() => new Date());
    this.client = rawClientOverride ?? buildRawProgressQueryClient(options);
  }

  async getCampaignProgress(params: GetCampaignProgressParams): Promise<RapCampaignProgress> {
    const response = await this.call<CampaignProgressResponseProto>(
      (metadata, options, callback) =>
        this.client.getCampaignProgress(
          { customerId: params.customerId, campaignCode: params.campaignCode },
          metadata,
          options,
          callback,
        ),
      params,
    );
    return {
      customerId: response.customerId,
      campaignCode: response.campaignCode,
      trackers: response.trackers.map(toTrackerProgress),
    };
  }

  async getTrackerProgress(params: GetTrackerProgressParams): Promise<RapTrackerProgress> {
    const response = await this.call<TrackerProgressResponseProto>(
      (metadata, options, callback) =>
        this.client.getTrackerProgress(
          {
            customerId: params.customerId,
            campaignCode: params.campaignCode,
            trackerCode: params.trackerCode,
          },
          metadata,
          options,
          callback,
        ),
      params,
    );
    return toTrackerProgress(response);
  }

  close(): void {
    this.client.close();
  }

  private call<T>(
    invoke: (
      metadata: grpc.Metadata,
      options: grpc.CallOptions,
      callback: (error: grpc.ServiceError | null, response: T) => void,
    ) => unknown,
    params: GetCampaignProgressParams,
  ): Promise<T> {
    const token = signProgressApiToken(
      {
        tenantId: params.tenantId,
        customerId: params.customerId,
        exp: Math.floor(this.now().getTime() / 1000) + this.tokenTtlSeconds,
      },
      this.secret,
    );
    const metadata = new grpc.Metadata();
    metadata.set('authorization', `Bearer ${token}`);

    return new Promise((resolve, reject) => {
      invoke(metadata, { deadline: Date.now() + this.timeoutMs }, (error, response) => {
        if (error) {
          if (
            error.code === grpc.status.UNAVAILABLE ||
            error.code === grpc.status.DEADLINE_EXCEEDED ||
            error.code === grpc.status.CANCELLED
          ) {
            reject(new RapProgressUnreachableError('GRPC', this.target, error));
            return;
          }
          reject(new RapProgressRequestError('GRPC', error.code, error.message));
          return;
        }
        resolve(response);
      });
    });
  }
}

function toTrackerProgress(proto: TrackerProgressViewProto): RapTrackerProgress {
  return {
    trackerCode: proto.trackerCode,
    // Proto3 has no `null` — empty string is RAP's own "no value" convention
    // (`progress_query.v1.proto`'s own header), translated back to `null` here.
    completionLogic: proto.completionLogic.length > 0 ? proto.completionLogic : null,
    isCompleted: proto.isCompleted,
    completedAt: proto.completedAt.length > 0 ? proto.completedAt : null,
    componentsRequiredCount: proto.componentsRequiredCount,
    componentsCompletedCount: proto.componentsCompletedCount,
    components: proto.components.map((component) => ({
      componentCode: component.componentCode,
      currentCount: component.currentCount,
      requiredCount: component.requiredCount,
      isCompleted: component.isCompleted,
    })),
  };
}
