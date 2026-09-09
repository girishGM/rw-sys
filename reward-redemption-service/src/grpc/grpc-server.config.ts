/**
 * T-RR-011. Environment configuration for the mTLS `RewardIngestService` gRPC server
 * (`03-GRPC-CONTRACT.md` §1). Read directly from `process.env`, deliberately **not**
 * `ConfigService`/`src/config/config.schema.ts` — `src/config/**` is `agent-rr-foundation`'s file
 * scope (`reward-redemption-service-plan/project.config.json`), and this agent's own delegated
 * scope is `src/grpc/**`/`src/messaging/ingest/**`/`src/rest/reward-entries/**`/
 * `src/modules/reward-ingestion/**`/`proto/**`/matching `test/**` dirs. Even though
 * `config.schema.ts` happens to already validate `GRPC_SERVER_PORT`/`GRPC_SERVER_TLS_*`/
 * `GRPC_SERVER_ALLOWED_IDENTITIES` as non-empty strings (T-RR-004 added them from Wave 0 onward so
 * a missing value fails boot loudly regardless of which wave actually wires the server), this
 * standalone gRPC composition root (`grpc-server.main.ts`) is deliberately independent of
 * `ConfigModule`/`AppModule` — the exact "standalone entry point" convention T-RR-011's own
 * implementation note 7 and RAP's own precedent (`realtime-activity-processing-service/src/grpc/
 * grpc-server.config.ts`, confirmed by direct read) both establish, so this transport's own tests
 * can freely override just its own env vars (e.g. a fresh ephemeral port per e2e run) without
 * booting the rest of this service's configuration surface. `GRPC_SERVER_ALLOWED_IDENTITIES`'s
 * own `identity:tenantId` parsing has no equivalent in `config.schema.ts` at all (that schema only
 * checks the raw string is non-empty) — this file is its one authoritative parser.
 *
 * ## The allowlist/tenant-resolution mechanism
 *
 * Same env-var-driven `identity -> tenantId` allowlist RAP's own inbound `ActivityIngestService`
 * uses (`03-GRPC-CONTRACT.md` §1's own note: "the same shape `service-identity.registry.ts` uses"),
 * not a Postgres-backed table — `RewardEntry` (like RAP's own `SubmitActivityRequest`) has no
 * caller-supplied `tenant_id` field whose trustworthiness would otherwise need separate
 * verification, so this allowlist is what establishes the claimed tenant context at all.
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

export const DEFAULT_GRPC_PORT = 50081;
export const GRPC_PACKAGE_NAME = 'rewardrap.reward.v1';
export const GRPC_SERVICE_NAME = 'RewardIngestService';

/** `reward-redemption-service/proto/reward_ingest.proto`, resolved relative to this file so it
 * works identically whether run via `ts-node` (this file under `src/`) or the compiled `dist/`
 * output (same relative depth: `dist/grpc/grpc-server.config.js` -> `../../proto/...`). */
export function resolveProtoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'reward_ingest.proto');
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
  const raw = process.env.GRPC_SERVER_PORT;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_GRPC_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid gRPC server configuration: GRPC_SERVER_PORT must be a positive integer, got "${raw}"`,
    );
  }
  return parsed;
}

/**
 * `GRPC_SERVER_ENABLED` (default `true`) — this task's own Rollback lever (task file's own
 * "Rollback" section: "remove the gRPC server bootstrap from whatever process-start script"), same
 * `promo-code-service`/RAP precedent. Set to `"false"` and `loadGrpcServerConfig()` returns `null`
 * instead of throwing on missing cert/key/CA paths, so a deployment that never provisioned mTLS
 * material for this transport can still boot with it simply absent, rather than crashing.
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
    rootCerts: readRequiredFile('GRPC_SERVER_TLS_CA_PATH'),
    serverCert: readRequiredFile('GRPC_SERVER_TLS_CERT_PATH'),
    serverKey: readRequiredFile('GRPC_SERVER_TLS_KEY_PATH'),
  };
}

/**
 * `identity -> tenantId` allowlist entries. Format:
 * `GRPC_SERVER_ALLOWED_IDENTITIES=identity1:1,identity2:2` — each entry is `<client-cert SAN/CN
 * identity>:<tenantId>`, comma-separated. Required whenever the gRPC server transport itself is
 * enabled — an mTLS server with no allowlist at all would either reject every caller (useless) or
 * (if the guard degraded to "any cert is fine") defeat the point of the allowlist, so a
 * missing/empty value fails boot loudly rather than silently starting wide open or fully closed.
 */
export function loadServiceIdentityRegistry(): ReadonlyMap<string, number> {
  const raw = process.env.GRPC_SERVER_ALLOWED_IDENTITIES?.trim();
  if (!raw) {
    throw new Error(
      'GRPC_SERVER_ALLOWED_IDENTITIES is required when GRPC_SERVER_ENABLED is not "false" ' +
        '(comma-separated "identity:tenantId" entries) — no default, no fallback (AGENT-PROTOCOL.md R8).',
    );
  }

  const entries = new Map<string, number>();
  for (const rawEntry of raw.split(',')) {
    const entry = rawEntry.trim();
    if (entry.length === 0) {
      continue;
    }
    const separatorIndex = entry.lastIndexOf(':');
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new Error(
        `Invalid GRPC_SERVER_ALLOWED_IDENTITIES entry "${entry}": expected "identity:tenantId"`,
      );
    }
    const identity = entry.slice(0, separatorIndex);
    const tenantIdRaw = entry.slice(separatorIndex + 1);
    const tenantId = Number.parseInt(tenantIdRaw, 10);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      throw new Error(
        `Invalid GRPC_SERVER_ALLOWED_IDENTITIES entry "${entry}": tenantId must be a positive integer`,
      );
    }
    entries.set(identity, tenantId);
  }

  if (entries.size === 0) {
    throw new Error(
      'GRPC_SERVER_ALLOWED_IDENTITIES must contain at least one "identity:tenantId" entry',
    );
  }

  return entries;
}
