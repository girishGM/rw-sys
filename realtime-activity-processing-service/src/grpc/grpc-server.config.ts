/**
 * T-RAP-022. Environment configuration for the mTLS `ActivityIngestService` gRPC server
 * (`03-GRPC-CONTRACT.md` §1). Read directly from `process.env`, **not**
 * `ConfigService`/`src/config/config.schema.ts`'s central `Config` type — `src/config/**` is
 * granted only to `agent-rap-foundation` (`realtime-activity-processing-service-plan/project.config.json`),
 * and this agent's own scope is `src/grpc/**`/`src/messaging/ingest/**`/`proto/**`/`test/grpc/**`/
 * `test/messaging/ingest/**`. Same exact precedent `campaign-config.client.ts`'s own header
 * documents for this project (`loadCampaignConfigClientOptions()`) and `promo-code-service`'s own
 * `grpc-server.config.ts` set for the sibling project — `validateGrpcServerConfig`-shaped
 * functions below are this file's own equivalent of `config.schema.ts`'s `validateConfig`: fail
 * boot loudly, not on the first real request (`AGENT-PROTOCOL.md` R8's spirit — no default
 * secret, no silent fallback — applied to this task's own env surface).
 *
 * ## The allowlist/tenant-resolution deviation from `promo-code-service`'s own `T-PC-031` precedent
 *
 * `03-GRPC-CONTRACT.md` §1's own note says this task should "follow whatever mechanism
 * `promo-code-service`'s own gRPC server (T-PC-031) established as this repo's precedent" — that
 * precedent is a Postgres-backed `grpc_service_identity` allowlist table
 * (`promo-code-service/src/database/migrations/008_create_promo_code_service_identity.ts`), owned
 * by a migration under `src/database/migrations/**`. That directory is **not** in this task's
 * granted file scope here (`src/database/**` is `agent-rap-foundation`'s, same as `src/config/**`
 * above) — T-RAP-022's own "Files owned" list has no migration entry, unlike T-PC-031's. Rather
 * than widen this task's scope by editing a file another task owns (`AGENT-PROTOCOL.md` R10), this
 * task uses an env-var-driven allowlist instead (`loadServiceIdentityRegistry` below), following
 * the exact same "read directly from `process.env`, fail boot loudly" discipline this codebase
 * already uses twice for the identical file-scope reason (`campaign-config.client.ts`'s
 * `PORTAL_GRPC_TLS_*`, `campaign-config-cache.service.ts`'s `PORTAL_CONFIG_TENANT_IDS`). The
 * mTLS-handshake half of the mechanism (client cert required and CA-verified before any handler
 * runs) and the allowlist-guard half (`mtls.guard.ts`) are otherwise structurally identical to
 * T-PC-031's own `MtlsGuard`/`ServiceIdentityRepository` split — only the allowlist's own storage
 * differs. Flagged in this task's completion report as a deliberate deviation, not an oversight.
 *
 * `SubmitActivityRequest` has no `tenant_id` field on the wire (`activity_ingest.proto`'s own
 * header) — `InboundActivity.tenantId` is resolved from the caller's own mTLS identity, so this
 * allowlist maps `identity -> tenantId`, not just `identity -> allowed/denied`.
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

export const DEFAULT_GRPC_PORT = 50071;
export const GRPC_PACKAGE_NAME = 'rewardrap.ingest.v1';
export const GRPC_SERVICE_NAME = 'ActivityIngestService';

/** `realtime-activity-processing-service/proto/activity_ingest.proto`, resolved relative to this
 * file so it works identically whether run via `ts-node` (this file under `src/`) or the compiled
 * `dist/` output (same relative depth: `dist/grpc/grpc-server.config.js` -> `../../proto/...`). */
export function resolveProtoPath(): string {
  return join(__dirname, '..', '..', 'proto', 'activity_ingest.proto');
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
 * "Rollback" section: "Disable the gRPC listener via config"), same `promo-code-service` precedent
 * (`grpc-server.config.ts` there). Set to `"false"` and `loadGrpcServerConfig()` returns `null`
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
 * `identity -> tenantId` allowlist entries (see this file's own header for why this is env-driven
 * rather than a DB table). Format: `GRPC_SERVER_ALLOWED_IDENTITIES=identity1:1,identity2:2` — each
 * entry is `<client-cert SAN/CN identity>:<tenantId>`, comma-separated. Required whenever the gRPC
 * server transport itself is enabled — an mTLS server with no allowlist at all would either reject
 * every caller (useless) or (if the guard degraded to "any cert is fine") defeat the point of the
 * allowlist, so a missing/empty value fails boot loudly rather than silently starting wide open or
 * fully closed.
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
