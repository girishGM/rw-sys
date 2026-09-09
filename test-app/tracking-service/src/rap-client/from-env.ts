/**
 * Builds a {@link RapActivityClient} from `RAP_GRPC_*` (`.env.example`), or returns `null` when
 * `RAP_GRPC_ENABLED` is explicitly `"false"` or the configuration is invalid.
 *
 * Deliberately a different default from `promo-code-client/from-env.ts` (which returns `null`
 * unless two required vars are both set): this integration is **on by default**, defaulting
 * `RAP_GRPC_HOST`/`RAP_GRPC_PORT` to `localhost:50071` — RAP's own `GRPC_SERVER_PORT` default
 * (`realtime-activity-processing-service/.env.example`) — the same "enabled unless explicitly
 * turned off" convention RAP's own `GRPC_SERVER_ENABLED`/`ACTIVITY_INGEST_CONSUMER_ENABLED` vars
 * use. Being on by default is safe specifically because `RapActivityClient.submitActivity` never
 * crashes the process on its own, and every caller of it (`routes/activities.ts`) treats every
 * outcome as best-effort — so an environment where RAP's gRPC server simply isn't running (the
 * common case per that service's own CLAUDE.md "Standalone entry points" section) just logs one
 * caught, harmless failure per submitted activity, exactly the same shape a misconfigured
 * `promo-code-service` integration already degrades to today.
 */
import { readFileSync } from 'node:fs';
import {
  DEFAULT_RAP_GRPC_PORT,
  DEFAULT_RAP_GRPC_TIMEOUT_MS,
  RapActivityClient,
  type RapClientOptions,
} from './client';

export function createRapClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RapActivityClient | null {
  if (env.RAP_GRPC_ENABLED === 'false') return null;

  const host = env.RAP_GRPC_HOST?.trim() || 'localhost';

  const rawPort = env.RAP_GRPC_PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_RAP_GRPC_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    console.warn(`rap-client: invalid RAP_GRPC_PORT "${rawPort}" — RAP integration disabled`);
    return null;
  }

  const rawTimeout = env.RAP_GRPC_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number.parseInt(rawTimeout, 10) : DEFAULT_RAP_GRPC_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    console.warn(
      `rap-client: invalid RAP_GRPC_TIMEOUT_MS "${rawTimeout}" — RAP integration disabled`,
    );
    return null;
  }

  const caPath = env.RAP_GRPC_TLS_CA_PATH?.trim();
  const certPath = env.RAP_GRPC_TLS_CERT_PATH?.trim();
  const keyPath = env.RAP_GRPC_TLS_KEY_PATH?.trim();
  const configuredTlsPaths = [caPath, certPath, keyPath].filter((value) => !!value);
  if (configuredTlsPaths.length > 0 && configuredTlsPaths.length < 3) {
    console.warn(
      'rap-client: RAP_GRPC_TLS_CA_PATH, RAP_GRPC_TLS_CERT_PATH and RAP_GRPC_TLS_KEY_PATH must ' +
        'all be set together, or none of them — RAP integration disabled',
    );
    return null;
  }

  let tls: RapClientOptions['tls'];
  if (caPath && certPath && keyPath) {
    try {
      tls = {
        rootCerts: readFileSync(caPath),
        clientCert: readFileSync(certPath),
        clientKey: readFileSync(keyPath),
      };
    } catch (error) {
      console.warn(
        `rap-client: failed to read RAP_GRPC_TLS_* certificate material — RAP integration disabled: ${describeCause(error)}`,
      );
      return null;
    }
  }

  try {
    return new RapActivityClient({ host, port, timeoutMs, tls });
  } catch (error) {
    console.warn(
      `rap-client: failed to construct the RAP gRPC client — RAP integration disabled: ${describeCause(error)}`,
    );
    return null;
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
