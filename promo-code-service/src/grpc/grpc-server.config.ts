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
