/**
 * T-RR-062. Tier — gRPC leg of outbound dispatch to reward-tracking-service
 * (`ARCHITECTURE.md` §9, `proto/reward_tracking_dispatch.proto`), the third transport alongside
 * `RewardTrackingKafkaProducerClient` (T-RR-034) and `RewardTrackingRestClient` (T-RR-035). Same
 * external shape as those two — one `dispatch(message)`-equivalent method — so
 * `OutboxPublisherService.attemptChannel()` needs only one new branch, not a restructure
 * (implementation note 4).
 *
 * No business logic lives here (R10) — `OutboxPublisherService` owns every retry/backoff/tier
 * decision; this class only knows how to make one unary gRPC call and throw on failure, the same
 * isolation `RewardTrackingKafkaProducerClient`/`RewardTrackingRestClient` already establish for
 * their own sibling transports.
 *
 * Connects **lazily, only on the first actual `dispatch()` call** — same discipline
 * `RewardTrackingKafkaProducerClient` documents for its own producer: a poll cycle with nothing to
 * publish must never open a gRPC channel, and booting a module that provides this class must never
 * fail or block on reward-tracking-service reachability (that service does not exist anywhere in
 * this repo today, `ARCHITECTURE.md` §9's own framing).
 *
 * **Auth/TLS** — reward-tracking-service names no auth mechanism for this channel in any design
 * doc (unlike promo-code-service's own gRPC port, which `03-GRPC-CONTRACT.md` fixes to mTLS-only —
 * `promo-code-service-grpc.client.ts`'s own header). This client follows the same "optional
 * TLS client-certificate material, insecure channel when none is configured" shape that file
 * establishes, ported here rather than reinvented, since no different convention is specified
 * anywhere for this new channel — flagged in this task's own completion report as an assumption
 * for the architect to confirm/adjust once reward-tracking-service's own contract exists for real.
 *
 * **Render note (implementation note 6, not a requirement of this task)**: this client is not
 * expected to run gRPC on Render at all — Render's edge-terminated TLS cannot support gRPC, the
 * same platform limitation `T-RR-031`/`promo-code-service-grpc.client.ts` already document for the
 * promo-code-service connector. `grpc_enabled` defaults `false` on every row (migration `021`), so
 * this client is never actually invoked in that environment unless an operator explicitly opts a
 * campaign into a future, non-Render deployment that can reach a real gRPC endpoint.
 */
import { Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

/** `RewardTrackingGrpcUnreachableError`'s own default port — not fixed by any design doc (this
 * channel has no confirmed real-world deployment yet); chosen simply to be distinct from every
 * other gRPC port already named in this project family (`50051` RAP's own `REWARD_REDEMPTION_GRPC_*`,
 * `50061` `PROMO_CODE_SERVICE_GRPC_*`, `50052`/`50053`-range portal `PORTAL_GRPC_*` — confirmed by
 * grep across this repo's own `.env.example` files). */
export const DEFAULT_REWARD_TRACKING_GRPC_PORT = 50071;
/** Same value, same reasoning, as `DEFAULT_REWARD_TRACKING_REST_TIMEOUT_MS` — a hung gRPC call
 * must never hold this connector open indefinitely either. */
export const DEFAULT_REWARD_TRACKING_GRPC_TIMEOUT_MS = 5_000;

export interface RewardTrackingGrpcClientOptions {
  host: string;
  port: number;
  timeoutMs: number;
  tls?: {
    rootCerts: Buffer;
    clientCert: Buffer;
    clientKey: Buffer;
  };
}

/**
 * `REWARD_TRACKING_GRPC_*` — a distinct env-var prefix from `REWARD_TRACKING_REST_*`
 * (`reward-tracking-rest.client.ts`) and every other `<PREFIX>_GRPC_*` family in this project
 * (`PROMO_CODE_SERVICE_GRPC_*`, `PORTAL_GRPC_*`, RAP's own `REWARD_REDEMPTION_GRPC_*`) — must never
 * inherit any of their host/port/TLS material by accident. Read directly from `process.env`, not
 * `ConfigService`/`src/config/config.schema.ts` — that shared schema is outside this task's file
 * scope (`src/config/**` is `agent-rr-foundation`'s), same precedent
 * `loadPromoCodeServiceGrpcClientOptions`/`loadRewardTrackingRestClientOptions` both already
 * establish.
 */
export function loadRewardTrackingGrpcClientOptions(): RewardTrackingGrpcClientOptions {
  const host = process.env.REWARD_TRACKING_GRPC_HOST?.trim() || 'localhost';
  const rawPort = process.env.REWARD_TRACKING_GRPC_PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_REWARD_TRACKING_GRPC_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid REWARD_TRACKING_GRPC_PORT: "${rawPort}" is not a positive integer`);
  }

  const rawTimeout = process.env.REWARD_TRACKING_GRPC_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout
    ? Number.parseInt(rawTimeout, 10)
    : DEFAULT_REWARD_TRACKING_GRPC_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `Invalid REWARD_TRACKING_GRPC_TIMEOUT_MS: "${rawTimeout}" is not a positive integer`,
    );
  }

  const caPath = process.env.REWARD_TRACKING_GRPC_TLS_CA_PATH?.trim();
  const certPath = process.env.REWARD_TRACKING_GRPC_TLS_CERT_PATH?.trim();
  const keyPath = process.env.REWARD_TRACKING_GRPC_TLS_KEY_PATH?.trim();
  if (!caPath && !certPath && !keyPath) {
    return { host, port, timeoutMs };
  }
  if (!caPath || !certPath || !keyPath) {
    throw new Error(
      'Invalid gRPC client TLS configuration: REWARD_TRACKING_GRPC_TLS_CA_PATH, ' +
        'REWARD_TRACKING_GRPC_TLS_CERT_PATH and REWARD_TRACKING_GRPC_TLS_KEY_PATH must all be set ' +
        'together, or none of them (got a partial set)',
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

/**
 * A transport-level "the server itself is unreachable" failure — never a per-message rejection.
 * `OutboxPublisherService` can catch this specifically the same way it already catches
 * `KafkaBrokerUnreachableError` (implementation note 4: "a transport-level unreachable-server
 * condition should trigger the same 'skip this row's own retry budget, go straight to the
 * fallback' behavior"), rather than falling into the slower per-row retry-count path meant for
 * message-level failures.
 */
export class RewardTrackingGrpcUnreachableError extends Error {
  constructor(cause: unknown) {
    super(
      `reward-tracking-service gRPC endpoint unreachable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'RewardTrackingGrpcUnreachableError';
  }
}

/** The one method `OutboxPublisherService` actually needs — narrow enough that a unit test can
 * substitute a plain fake object instead of standing up a real gRPC server, mirroring
 * `RewardTrackingKafkaProducerPort`/`RewardTrackingRestClientPort`. `message` is the exact shared
 * shape `toRewardTrackingMessage` (`reward-tracking-outbox.repository.ts`) already builds for the
 * Kafka/REST legs — the caller has already decrypted `customerId` onto it (R8) before this method
 * ever sees it. */
export interface RewardTrackingGrpcClientPort {
  dispatch(message: Record<string, unknown>): Promise<void>;
}

interface RawRewardTrackingDispatchClient extends grpc.Client {
  ingestRewardTrackingEvent(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: { status?: string }) => void,
  ): grpc.ClientUnaryCall;
}

function resolveProtoPath(): string {
  return join(__dirname, '..', '..', '..', 'proto', 'reward_tracking_dispatch.proto');
}

function buildCredentials(options: RewardTrackingGrpcClientOptions): grpc.ChannelCredentials {
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
 * `message`'s int/string fields map 1:1 onto `RedemptionCompletedMessage`'s own proto field names
 * (snake_case) — `@grpc/proto-loader`'s own `keepCase: false` option (below) means the loaded stub
 * actually expects/returns camelCase, so no manual field-name translation is needed here beyond
 * substituting proto3's "empty means absent" convention for this service's own `null`.
 */
function toWireMessage(message: Record<string, unknown>): Record<string, unknown> {
  const asString = (value: unknown): string =>
    value === null || value === undefined ? '' : String(value);
  const asInt = (value: unknown): number =>
    value === null || value === undefined ? 0 : Number(value);
  return {
    rewardEntryId: asString(message.rewardEntryId),
    correlationId: asString(message.correlationId),
    tenantId: asInt(message.tenantId),
    tenantCode: asString(message.tenantCode),
    countryCode: asString(message.countryCode),
    customerId: asString(message.customerId),
    campaignCode: asString(message.campaignCode),
    trackerCode: asString(message.trackerCode),
    trackerComponentCode: asString(message.trackerComponentCode),
    merchantCode: asString(message.merchantCode),
    rewardCode: asString(message.rewardCode),
    rewardCategory: asString(message.rewardCategory),
    rewardKind: asString(message.rewardKind),
    // RTS's real request message declares `unit_type`/`unit_code` at wire positions 14/15 — RR has
    // no data to populate them yet (T-INT-002's own proto header note), so they're always sent
    // absent ("").
    unitType: '',
    unitCode: '',
    rewardValue: asString(message.rewardValue),
    rewardValueUnit: asString(message.rewardValueUnit),
    externalSystemCode: asString(message.externalSystemCode),
    externalReferenceId: asString(message.externalReferenceId),
    promoCodeConfigId: asString(message.promoCodeConfigId),
    promoCodeConfigVersionNo: asInt(message.promoCodeConfigVersionNo),
    redeemedAt: asString(message.redeemedAt),
    expiresAt: asString(message.expiresAt),
  };
}

@Injectable()
export class RewardTrackingGrpcClient implements RewardTrackingGrpcClientPort, OnModuleDestroy {
  private readonly logger = new Logger(RewardTrackingGrpcClient.name);
  private readonly timeoutMs: number;
  private client: RawRewardTrackingDispatchClient | null = null;

  /**
   * `@Optional()` on `options` — the identical fix `T-RR-064` applied to
   * `RewardTrackingRestClient` for the identical reason (see that file's own header for the full
   * mechanism): `options`'s type is a plain interface, erased at compile time, so TypeScript's
   * emitted `design:paramtypes` metadata for this constructor parameter cannot be mapped to any
   * registered provider token. Without `@Optional()`, Nest's automatic constructor-injection would
   * throw `"Nest can't resolve dependencies of the RewardTrackingGrpcClient (?)"` at module-compile
   * time, before this constructor body — or its JS-level default parameter — ever runs. With
   * `@Optional()`, an unresolvable dependency resolves to `undefined`, and the JS-level default
   * still applies, so `loadRewardTrackingGrpcClientOptions()` still runs for a real, env-derived
   * options object when constructed via real Nest DI with no matching provider. Every unit test in
   * this file's own spec constructs this class with `new RewardTrackingGrpcClient(options)`,
   * always passing an explicit argument, so none of them relies on this default at all.
   */
  constructor(
    @Optional()
    private readonly options: RewardTrackingGrpcClientOptions = loadRewardTrackingGrpcClientOptions(),
  ) {
    this.timeoutMs = options.timeoutMs;
  }

  private connect(): RawRewardTrackingDispatchClient {
    if (this.client) {
      return this.client;
    }
    const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      rewardtracking: {
        ingest: { v1: { RewardTrackingIngestService: new (...args: unknown[]) => grpc.Client } };
      };
    };
    const ServiceCtor = proto.rewardtracking.ingest.v1.RewardTrackingIngestService;
    this.client = new ServiceCtor(
      `${this.options.host}:${this.options.port}`,
      buildCredentials(this.options),
    ) as RawRewardTrackingDispatchClient;
    return this.client;
  }

  /**
   * Throws `RewardTrackingGrpcUnreachableError` for any transport/deadline failure (no server
   * listening, connection refused, deadline exceeded — `grpc.status.UNAVAILABLE`/
   * `DEADLINE_EXCEEDED`), so `OutboxPublisherService` can tell it apart from a message-level
   * rejection the same way it already does for `KafkaBrokerUnreachableError`. Any other gRPC
   * status is re-thrown as-is (a genuine per-message failure). R8: never logs `message` — it may
   * carry the plaintext `customerId` this client was handed at the point of publish.
   */
  async dispatch(message: Record<string, unknown>): Promise<void> {
    const client = this.connect();
    await new Promise<void>((resolve, reject) => {
      client.ingestRewardTrackingEvent(
        toWireMessage(message),
        new grpc.Metadata(),
        { deadline: Date.now() + this.timeoutMs },
        (error, response) => {
          if (error) {
            this.logger.warn(`reward-tracking-service gRPC dispatch failed: ${error.message}`);
            if (
              error.code === grpc.status.UNAVAILABLE ||
              error.code === grpc.status.DEADLINE_EXCEEDED
            ) {
              reject(new RewardTrackingGrpcUnreachableError(error));
              return;
            }
            reject(error);
            return;
          }
          // RTS's real response is exactly `{status: 'applied' | 'duplicate'}`
          // (`reward_tracking_ingest.proto`'s own `IngestRewardTrackingEventResponse` comment) —
          // never `"ACCEPTED"`, which was T-RR-062's own pre-RTS guess.
          if (response?.status !== 'applied' && response?.status !== 'duplicate') {
            reject(
              new Error(
                `reward-tracking-service gRPC call returned an unexpected status ` +
                  `(expected "applied" or "duplicate", got ${JSON.stringify(response?.status)})`,
              ),
            );
            return;
          }
          resolve();
        },
      );
    });
  }

  onModuleDestroy(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }
}
