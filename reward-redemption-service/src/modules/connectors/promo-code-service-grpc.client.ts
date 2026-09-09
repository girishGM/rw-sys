/**
 * T-RR-080. Thin gRPC client wrapper around `PromoCodeService.GenerateCode`
 * (`proto/promo_code_generation.proto`, this file's own client-side contract — see that file's
 * header) — the gRPC transport variant of the exact same call `PromoCodeServiceConnector`'s
 * existing REST path already makes. Pure transport plumbing — (de)serialization and
 * promisification only, no retry/fallback/classification logic (that's
 * `PromoCodeServiceConnector.redeem()`'s own job, mirroring how `RewardGrpcFallbackClient`/
 * `campaign-config.client.ts` keep the identical split in this project family).
 *
 * Ported from RAP's own proven `reward-grpc-fallback.client.ts` (confirmed by direct read) — same
 * shape, same env-var-naming convention (`PROMO_CODE_SERVICE_GRPC_*`, mirroring that file's own
 * `REWARD_REDEMPTION_GRPC_*`), same insecure-channel-when-no-TLS-material-configured fallback.
 *
 * **Auth — a documented deviation from T-RR-080's own implementation note 2.** That note assumes
 * this client reuses `GENERATION_SERVICE_TOKEN` (the REST connector's bearer secret) as this
 * channel's own credential, citing `04-API-CONTRACT.md` §5's "gRPC and REST are two skins over one
 * contract." Direct read of the actual, already-built server side proves that assumption wrong for
 * *auth* specifically (the "one contract" framing is about the generation business logic, not the
 * transport's own credential): `03-GRPC-CONTRACT.md` §3 ("mTLS between reward-redemption-service
 * and this service ... No portal session cookie or JWT is ever accepted on this port") and
 * `promo-code-service/src/grpc/mtls.guard.ts`'s own header confirm this port authenticates
 * exclusively via an allowlisted mTLS client certificate — "nothing in this file, or anywhere else
 * on this transport's pipeline, ever inspects gRPC metadata for a bearer token or cookie header."
 * `grpc-server.bootstrap.ts` additionally proves this is enforced at the TLS handshake itself
 * (`ServerCredentials.createSsl(..., checkClientCertificate: true)`), before any application code
 * (a bearer token in this channel's metadata would never even reach a handler to be checked). Per
 * `AGENT-PROTOCOL.md` §3 ("if the task description conflicts with a design doc, the design doc
 * wins; note the conflict"), this client therefore supports optional mTLS client-certificate
 * material (env-var-configured, `T-RR-080`'s own new, additive config surface — never
 * `GENERATION_SERVICE_TOKEN`) instead of sending any bearer token over this channel, and falls back
 * to an insecure channel when no TLS material is configured — the same "expected to fail closed in
 * any environment where the real server isn't reachable with valid certs" posture
 * `RewardGrpcFallbackClient`'s own header documents for the identical situation. No new *bearer*
 * credential is provisioned either way — the note's actual intent ("do not invent a second secret
 * store") is honored; only the transport-appropriate credential shape it guessed wrong on changes.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type {
  PromoCodeGenerateRequest,
  PromoCodeGenerateResponse,
} from './promo-code-service.connector.types';

/** `03-GRPC-CONTRACT.md` §3's own confirmed port. */
export const DEFAULT_PROMO_CODE_SERVICE_GRPC_PORT = 50061;
/** Same value, same reasoning, as `PROMO_CODE_SERVICE_CALL_TIMEOUT_MS` (the REST connector's own
 * bounded per-call timeout) — a hung gRPC call must never hold this connector open indefinitely
 * either. */
export const DEFAULT_PROMO_CODE_SERVICE_GRPC_TIMEOUT_MS = 5_000;

export interface PromoCodeServiceGrpcClientOptions {
  host: string;
  port: number;
  timeoutMs: number;
  tls?: {
    rootCerts: Buffer;
    clientCert: Buffer;
    clientKey: Buffer;
  };
}

/** `PROMO_CODE_SERVICE_GRPC_*` — deliberately a distinct env-var prefix from `PORTAL_GRPC_*`
 * (`campaign-config.client.ts`) and RAP's own `REWARD_REDEMPTION_GRPC_*`: a different remote
 * service entirely, must never inherit either one's host/port/TLS material by accident. Env vars
 * read directly from `process.env`, not `ConfigService`/`src/config/config.schema.ts` — that shared
 * schema is outside this task's file scope (`src/config/**` is `agent-rr-foundation`'s), the same
 * precedent `campaign-config.client.ts`'s own header documents for `PORTAL_GRPC_*` (T-RR-022).
 */
export function loadPromoCodeServiceGrpcClientOptions(): PromoCodeServiceGrpcClientOptions {
  const host = process.env.PROMO_CODE_SERVICE_GRPC_HOST?.trim() || 'localhost';
  const rawPort = process.env.PROMO_CODE_SERVICE_GRPC_PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_PROMO_CODE_SERVICE_GRPC_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PROMO_CODE_SERVICE_GRPC_PORT: "${rawPort}" is not a positive integer`);
  }

  const rawTimeout = process.env.PROMO_CODE_SERVICE_GRPC_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout
    ? Number.parseInt(rawTimeout, 10)
    : DEFAULT_PROMO_CODE_SERVICE_GRPC_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `Invalid PROMO_CODE_SERVICE_GRPC_TIMEOUT_MS: "${rawTimeout}" is not a positive integer`,
    );
  }

  const caPath = process.env.PROMO_CODE_SERVICE_GRPC_TLS_CA_PATH?.trim();
  const certPath = process.env.PROMO_CODE_SERVICE_GRPC_TLS_CERT_PATH?.trim();
  const keyPath = process.env.PROMO_CODE_SERVICE_GRPC_TLS_KEY_PATH?.trim();
  if (!caPath && !certPath && !keyPath) {
    return { host, port, timeoutMs };
  }
  if (!caPath || !certPath || !keyPath) {
    throw new Error(
      'Invalid gRPC client TLS configuration: PROMO_CODE_SERVICE_GRPC_TLS_CA_PATH, ' +
        'PROMO_CODE_SERVICE_GRPC_TLS_CERT_PATH and PROMO_CODE_SERVICE_GRPC_TLS_KEY_PATH must all ' +
        'be set together, or none of them (got a partial set)',
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

interface RawPromoCodeServiceClient extends grpc.Client {
  generateCode(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: PromoCodeGenerateResponse) => void,
  ): grpc.ClientUnaryCall;
}

function resolveProtoPath(): string {
  return join(__dirname, '..', '..', '..', 'proto', 'promo_code_generation.proto');
}

function buildCredentials(options: PromoCodeServiceGrpcClientOptions): grpc.ChannelCredentials {
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
export class PromoCodeServiceGrpcClient implements OnModuleDestroy {
  private readonly logger = new Logger(PromoCodeServiceGrpcClient.name);
  private readonly timeoutMs: number;
  private readonly client: RawPromoCodeServiceClient;

  constructor(
    options: PromoCodeServiceGrpcClientOptions = loadPromoCodeServiceGrpcClientOptions(),
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
      promocode: { v1: { PromoCodeService: new (...args: unknown[]) => grpc.Client } };
    };
    const ServiceCtor = proto.promocode.v1.PromoCodeService;
    this.client = new ServiceCtor(
      `${options.host}:${options.port}`,
      buildCredentials(options),
    ) as RawPromoCodeServiceClient;
  }

  /** Throws on any transport/deadline failure (no client certificate, connection refused, deadline
   * exceeded) — the caller (`PromoCodeServiceConnector.redeem()`) decides what that means (fall
   * back to REST within the same call), never this method. A completed response — `status:
   * "SUCCESS" | "FAILED"` — is returned normally either way: `03-GRPC-CONTRACT.md` §5's own "a
   * business outcome is not a protocol-level fault" convention, mirrored exactly from the REST
   * connector's own `PromoCodeGenerateResponse` handling.
   *
   * **T-RR-090.** `versionNo` is this connector's own shared `string | null` — this transport's
   * *own* "absent" representation is proto3's empty-string default, not `null` (a `null` handed to
   * protobufjs for a `string` field is not the same "legitimate absent value" every other transport
   * treats it as). Translated at exactly this one boundary, both directions: `null -> ''` on the
   * way out, and the mirror `'' -> null` on the way back in on the response — the real server's own
   * gRPC controller applies the identical `emptyToUndefined(...) ?? null` translation on its side
   * (confirmed by direct read of `promo-code.controller.ts`), so this is not a guess at the wire
   * convention. */
  async generateCode(request: PromoCodeGenerateRequest): Promise<PromoCodeGenerateResponse> {
    const wireRequest = { ...request, versionNo: request.versionNo ?? '' };
    return new Promise((resolve, reject) => {
      this.client.generateCode(
        wireRequest,
        new grpc.Metadata(),
        { deadline: Date.now() + this.timeoutMs },
        (error, response) => {
          if (error) {
            this.logger.warn(
              `GenerateCode (gRPC) failed for correlationId ${request.correlationId}: ${error.message}`,
            );
            reject(error);
            return;
          }
          resolve({
            ...response,
            versionNo:
              response.versionNo && response.versionNo.length > 0 ? response.versionNo : null,
          });
        },
      );
    });
  }

  onModuleDestroy(): void {
    this.client.close();
  }
}
