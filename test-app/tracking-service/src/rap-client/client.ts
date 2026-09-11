/**
 * Thin gRPC client wrapping `realtime-activity-processing-service`'s real
 * `ActivityIngestService.SubmitActivity` (`../proto/activity_ingest.proto` — a local copy, see
 * that file's header for why). Pure transport plumbing only, mirroring the split
 * `promo-code-client/client.ts` already established for this app's other real integration
 * (`PromoCodeClient`): this class does the call and throws typed errors
 * (`errors.ts`) on failure; it is `routes/activities.ts`'s job, not this file's, to catch those and
 * fall back gracefully — same "an optional integration must never break the demo" contract
 * `engine/reward.ts`'s `resolvePromoCode` already established for promo-code-service.
 *
 * ## Why this degrades gracefully by design, not just by accident
 *
 * `realtime-activity-processing-service/CLAUDE.md`'s own "Standalone entry points" section
 * confirms its gRPC server (`src/grpc/grpc-server.main.ts`) is not wired into that service's
 * deployed `AppModule` and is not started anywhere by default, even locally — it only runs if
 * someone starts it by hand with real mTLS certificate material configured. So in the overwhelming
 * common case, every call this client makes will fail to even connect. Every failure mode
 * (connection refused, TLS handshake failure, deadline exceeded, a real rejected-request status)
 * is surfaced as one of three typed errors below, never an uncaught throw or an unhandled
 * rejection — `submitActivity` always either resolves or rejects with one of them.
 *
 * ## mTLS
 *
 * RAP's own server refuses any connection without a CA-signed client certificate at the TLS
 * handshake itself, before `MtlsGuard` or any handler ever runs (`mtls.guard.ts`'s own header).
 * This client mirrors `realtime-activity-processing-service`'s own outbound-client precedent
 * (`modules/campaign-cache/campaign-config.client.ts`'s `loadCampaignConfigClientOptions`): TLS
 * material is optional, all three of `RAP_GRPC_TLS_CA_PATH`/`_CERT_PATH`/`_KEY_PATH` or none
 * (`from-env.ts`), and the channel falls back to insecure credentials when none are configured —
 * which will simply fail the handshake against a real mTLS-enabled RAP server, a failure this
 * client already catches and reports as {@link RapServiceUnreachableError}.
 */
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  RapServiceRequestError,
  RapServiceUnreachableError,
  RapServiceValidationError,
} from './errors';
import type { RapActivitySubmitter, SubmitActivityRequest, SubmitActivityResponse } from './types';

export const DEFAULT_RAP_GRPC_PORT = 50071;
/** This task's own "2-3 seconds" requirement — generous enough for a real local network hop, short
 * enough that a RAP that isn't running fails fast rather than holding the demo's fire-and-forget
 * call open for any meaningful time. */
export const DEFAULT_RAP_GRPC_TIMEOUT_MS = 2_500;

export interface RapClientOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly tls?: {
    readonly rootCerts: Buffer;
    readonly clientCert: Buffer;
    readonly clientKey: Buffer;
  };
}

/** Shape of the dynamically-loaded `ActivityIngestService` grpc-js client this file wraps, and the
 * one seam `client.spec.ts` injects a fake through instead of opening a real channel. */
export interface RawActivityIngestServiceClient {
  submitActivity(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: SubmitActivityResponse) => void,
  ): unknown;
  close(): void;
}

function resolveProtoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'activity_ingest.proto');
}

function buildCredentials(options: RapClientOptions): grpc.ChannelCredentials {
  if (!options.tls) return grpc.credentials.createInsecure();
  return grpc.credentials.createSsl(
    options.tls.rootCerts,
    options.tls.clientKey,
    options.tls.clientCert,
  );
}

export function buildRawClient(options: RapClientOptions): RawActivityIngestServiceClient {
  const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    rewardrap: {
      ingest: { v1: { ActivityIngestService: new (...args: unknown[]) => grpc.Client } };
    };
  };
  const ServiceCtor = proto.rewardrap.ingest.v1.ActivityIngestService;
  return new ServiceCtor(
    `${options.host}:${options.port}`,
    buildCredentials(options),
  ) as unknown as RawActivityIngestServiceClient;
}

/** Mirrors the exact required-field rules RAP's real `ActivityIngestController.toInboundActivity`
 * enforces (`activity-ingest.controller.ts`) — fails fast, locally, with no network call, rather
 * than letting a malformed request travel all the way to RAP (or to a mocked channel in tests)
 * only to bounce back as an opaque wire-level error. Returns the first violation found, or `null`
 * when the request is well-formed. */
export function validateSubmitActivityRequest(request: SubmitActivityRequest): string | null {
  const requiredNonEmpty: ReadonlyArray<[string, string | undefined]> = [
    ['customerId', request.customerId],
    ['customerIdType', request.customerIdType],
    ['activityPerformedDate', request.activityPerformedDate],
    ['activityType', request.activityType],
    ['activityCategory', request.activityCategory],
    ['activityValue', request.activityValue],
    ['activityValueUnit', request.activityValueUnit],
    ['channel', request.channel],
    ['activityPerformedEnv', request.activityPerformedEnv],
    ['activityName', request.activityName],
  ];
  for (const [field, value] of requiredNonEmpty) {
    if (!value || value.trim().length === 0) {
      return `${field} is required`;
    }
  }
  if (
    (!request.transactionType || request.transactionType.trim().length === 0) &&
    (!request.activityCode || request.activityCode.trim().length === 0)
  ) {
    return 'one of transactionType or activityCode is required';
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(request.activityPerformedDate.trim())) {
    return 'activityPerformedDate must carry an explicit UTC offset (e.g. a trailing "Z")';
  }
  return null;
}

/** T-INT-054 — the gRPC transport option (`RapActivitySubmitter`, `types.ts`); `rest.client.ts`'s
 * `RapActivityRestClient` is the new REST option, and `configurable.client.ts`'s
 * `ConfigurableRapActivityClient` selects between the two. */
export class RapActivityClient implements RapActivitySubmitter {
  private readonly client: RawActivityIngestServiceClient;
  private readonly timeoutMs: number;
  private readonly target: string;

  constructor(options: RapClientOptions, rawClientOverride?: RawActivityIngestServiceClient) {
    this.timeoutMs = options.timeoutMs;
    this.target = `${options.host}:${options.port}`;
    this.client = rawClientOverride ?? buildRawClient(options);
  }

  async submitActivity(request: SubmitActivityRequest): Promise<SubmitActivityResponse> {
    const validationError = validateSubmitActivityRequest(request);
    if (validationError) {
      throw new RapServiceValidationError(validationError);
    }

    return new Promise((resolve, reject) => {
      this.client.submitActivity(
        request,
        new grpc.Metadata(),
        { deadline: Date.now() + this.timeoutMs },
        (error, response) => {
          if (error) {
            if (
              error.code === grpc.status.UNAVAILABLE ||
              error.code === grpc.status.DEADLINE_EXCEEDED ||
              error.code === grpc.status.CANCELLED
            ) {
              reject(new RapServiceUnreachableError(this.target, error));
              return;
            }
            reject(new RapServiceRequestError(error.code, error.message));
            return;
          }
          resolve(response);
        },
      );
    });
  }

  close(): void {
    this.client.close();
  }
}
