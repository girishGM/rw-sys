/**
 * T-PC-031. Environment configuration for the mTLS gRPC server (`03-GRPC-CONTRACT.md` §3).
 *
 * Read directly from `process.env`, **not** `ConfigService`/`src/config/config.schema.ts`'s
 * central `Config` type — same file-scope reason `internal-service-token.guard.ts` (T-PC-011)
 * already documents: `src/config/**` is granted only to `agent-promo-foundation`
 * (`project.config.json`), and this agent's own scope is `src/grpc/**`/`src/messaging/**`/
 * `proto/**`/`test/grpc/**`/`test/messaging/**`. `validateGrpcServerConfig` below is this file's
 * own equivalent of that schema's `validateConfig` — same "fail boot loudly, not on the first
 * real request" discipline (AGENT-PROTOCOL.md R4), just scoped to this module's own env keys
 * instead of being appended to the shared schema.
 *
 * `GRPC_SERVER_ENABLED` (default `true`) is the Rollback lever the task file's own "Rollback"
 * section asks for ("Disable the gRPC listener via config") — set to `false` (or any value other
 * than `true`) and `loadGrpcServerConfig()` returns `null` instead of throwing on missing
 * cert/key/CA paths, so a deployment that never provisioned mTLS material for this service can
 * still boot with the gRPC transport simply absent, rather than crashing at startup.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GrpcServerConfig {
  port: number;
  protoPath: string;
  packageName: string;
  serviceName: string;
  rootCerts: Buffer;
  serverCert: Buffer;
  serverKey: Buffer;
}

export const DEFAULT_GRPC_PORT = 50061;
export const GRPC_PACKAGE_NAME = 'promocode.v1';
export const GRPC_SERVICE_NAME = 'PromoCodeService';

/** `promo-code-service/proto/promo_code.v1.proto`, resolved relative to this file so it works
 * identically whether run via `ts-node` (this file under `src/`) or the compiled `dist/` output
 * (same relative depth: `dist/grpc/grpc-server.config.js` → `../../proto/...`). */
export function resolveProtoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'promo_code.v1.proto');
}

function readRequiredFile(envVar: string): Buffer {
  const path = process.env[envVar];
  if (!path || path.trim().length === 0) {
    throw new Error(
      `Invalid gRPC server configuration: ${envVar} is required when GRPC_SERVER_ENABLED is not "false"`,
    );
  }
  try {
    return readFileSync(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid gRPC server configuration: cannot read ${envVar} ("${path}"): ${reason}`,
    );
  }
}

function parsePort(): number {
  const raw = process.env.GRPC_PORT;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_GRPC_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid gRPC server configuration: GRPC_PORT must be a positive integer, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * T-PC-048. `codes_generated_total`/`promo_code_generation_duration_seconds` only reflect real
 * generation once `GrpcServerModule` imports `MetricsModule` (see that module's own T-PC-048
 * note) — but that instrumentation is useless to an operator unless *this* process's own
 * `GET /metrics` is reachable: `GrpcMicroserviceRootModule` bootstraps via
 * `NestFactory.createMicroservice`/no HTTP listener at all before this task, so a scraper aimed
 * only at the HTTP `AppModule` process never sees a gRPC-originated generation (the defect this
 * task fixes — see `grpc-server.main.ts`'s own header). `GRPC_METRICS_PORT` (default 9101,
 * distinct from the HTTP `AppModule`'s own default `PORT` 3010 and the Kafka consumer process's
 * own `KAFKA_METRICS_PORT` default 9102, so all three can run on one dev machine at once without
 * colliding) is this process's own metrics HTTP port.
 */
export const DEFAULT_GRPC_METRICS_PORT = 9101;

export function parseGrpcMetricsPort(): number {
  const raw = process.env.GRPC_METRICS_PORT;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_GRPC_METRICS_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid gRPC server configuration: GRPC_METRICS_PORT must be a positive integer, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * `GRPC_METRICS_ENABLED` (default enabled) — this task's own Rollback lever, same
 * `GRPC_SERVER_ENABLED` convention above: set to `"false"` to keep the gRPC transport itself
 * running while turning off just its `GET /metrics` HTTP listener, with nothing left to tear
 * down separately (no socket is ever opened).
 */
export function isGrpcMetricsListenerEnabled(): boolean {
  return process.env.GRPC_METRICS_ENABLED !== 'false';
}

/**
 * Returns `null` when `GRPC_SERVER_ENABLED=false` — the transport is deliberately absent, not
 * misconfigured. Otherwise validates and loads the mTLS certificate material eagerly (never lazily
 * on the first connection), throwing synchronously so a missing/unreadable cert fails boot loudly
 * (mirrors `config.schema.ts`'s own `validateConfig` contract, R4).
 */
export function loadGrpcServerConfig(): GrpcServerConfig | null {
  if (process.env.GRPC_SERVER_ENABLED === 'false') {
    return null;
  }
  return {
    port: parsePort(),
    protoPath: resolveProtoPath(),
    packageName: GRPC_PACKAGE_NAME,
    serviceName: GRPC_SERVICE_NAME,
    rootCerts: readRequiredFile('GRPC_TLS_CA_PATH'),
    serverCert: readRequiredFile('GRPC_TLS_CERT_PATH'),
    serverKey: readRequiredFile('GRPC_TLS_KEY_PATH'),
  };
}
