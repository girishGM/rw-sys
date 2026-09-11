/**
 * Builds a {@link RapActivitySubmitter} from `RAP_GRPC_*`/`RAP_ACTIVITY_REST_*`
 * (`.env.example`), or returns `null` when `RAP_GRPC_ENABLED` is explicitly `"false"` AND the REST
 * transport is also unconfigured (see below) — this integration stays on-by-default overall
 * (T-INT-054 preserves this file's own pre-existing "enabled unless explicitly turned off"
 * philosophy), even though each individual transport can now independently be unavailable.
 *
 * T-INT-054 added the REST transport (`rest.client.ts`) and the configurable primary/fallback
 * selector (`configurable.client.ts`) alongside the pre-existing gRPC-only client — mirroring
 * `rap-progress-client/from-env.ts`'s own precedent for a leg with two real transports. A
 * misconfigured/disabled transport degrades to a `FailClosedSubmitter` for THAT transport only
 * (never the whole integration) — the configurable client automatically tries the other one, the
 * same graceful-degradation contract this integration already had (see this file's own
 * "on by default" reasoning below).
 */
import { readFileSync } from 'node:fs';
import {
  DEFAULT_RAP_GRPC_PORT,
  DEFAULT_RAP_GRPC_TIMEOUT_MS,
  RapActivityClient,
  type RapClientOptions,
} from './client';
import { ConfigurableRapActivityClient, type RapActivityTransport } from './configurable.client';
import { RapServiceTransportNotAvailableError } from './errors';
import { RapActivityRestClient } from './rest.client';
import type { RapActivitySubmitter, SubmitActivityRequest, SubmitActivityResponse } from './types';

export const DEFAULT_RAP_ACTIVITY_REST_BASE_URL = 'http://localhost:3020';
export const DEFAULT_RAP_ACTIVITY_REST_TIMEOUT_MS = 2_500;

/** Always throws {@link RapServiceTransportNotAvailableError} — used in place of a real client for
 * whichever transport is disabled/misconfigured, so a broken local setup fails that one transport
 * closed rather than crashing this client's construction or silently disabling the other transport
 * too. Mirrors `rap-progress-client/from-env.ts`'s own `FailClosedProgressReader`. */
class FailClosedSubmitter implements RapActivitySubmitter {
  constructor(
    private readonly transport: 'REST' | 'GRPC',
    private readonly reason: string,
  ) {}

  async submitActivity(_request: SubmitActivityRequest): Promise<SubmitActivityResponse> {
    throw new RapServiceTransportNotAvailableError(this.transport, this.reason);
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function buildGrpcSubmitter(env: NodeJS.ProcessEnv): RapActivitySubmitter {
  if (env.RAP_GRPC_ENABLED === 'false') {
    return new FailClosedSubmitter('GRPC', 'RAP_GRPC_ENABLED=false');
  }

  const host = env.RAP_GRPC_HOST?.trim() || 'localhost';

  const rawPort = env.RAP_GRPC_PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_RAP_GRPC_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    console.warn(`rap-client: invalid RAP_GRPC_PORT "${rawPort}" — GRPC transport disabled`);
    return new FailClosedSubmitter('GRPC', `invalid RAP_GRPC_PORT "${rawPort}"`);
  }

  const rawTimeout = env.RAP_GRPC_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number.parseInt(rawTimeout, 10) : DEFAULT_RAP_GRPC_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    console.warn(
      `rap-client: invalid RAP_GRPC_TIMEOUT_MS "${rawTimeout}" — GRPC transport disabled`,
    );
    return new FailClosedSubmitter('GRPC', `invalid RAP_GRPC_TIMEOUT_MS "${rawTimeout}"`);
  }

  const caPath = env.RAP_GRPC_TLS_CA_PATH?.trim();
  const certPath = env.RAP_GRPC_TLS_CERT_PATH?.trim();
  const keyPath = env.RAP_GRPC_TLS_KEY_PATH?.trim();
  const configuredTlsPaths = [caPath, certPath, keyPath].filter((value) => !!value);
  if (configuredTlsPaths.length > 0 && configuredTlsPaths.length < 3) {
    console.warn(
      'rap-client: RAP_GRPC_TLS_CA_PATH, RAP_GRPC_TLS_CERT_PATH and RAP_GRPC_TLS_KEY_PATH must ' +
        'all be set together, or none of them — GRPC transport disabled',
    );
    return new FailClosedSubmitter('GRPC', 'partial RAP_GRPC_TLS_* configuration');
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
        `rap-client: failed to read RAP_GRPC_TLS_* certificate material — GRPC transport disabled: ${describeCause(error)}`,
      );
      return new FailClosedSubmitter('GRPC', 'unreadable RAP_GRPC_TLS_* certificate material');
    }
  }

  try {
    return new RapActivityClient({ host, port, timeoutMs, tls });
  } catch (error) {
    console.warn(
      `rap-client: failed to construct the RAP gRPC client — GRPC transport disabled: ${describeCause(error)}`,
    );
    return new FailClosedSubmitter('GRPC', `failed to construct: ${describeCause(error)}`);
  }
}

/** T-INT-054's own new transport. Defaults ON (same "sane localhost default" philosophy this whole
 * file already has for gRPC) except for its one real secret, `RAP_ACTIVITY_REST_TOKEN` — no safe
 * default exists for that (R4), so it alone determines whether REST is usable. */
function buildRestSubmitter(env: NodeJS.ProcessEnv): RapActivitySubmitter {
  const token = env.RAP_ACTIVITY_REST_TOKEN?.trim();
  if (!token) {
    return new FailClosedSubmitter('REST', 'RAP_ACTIVITY_REST_TOKEN is not set');
  }

  const baseUrl = env.RAP_ACTIVITY_REST_BASE_URL?.trim() || DEFAULT_RAP_ACTIVITY_REST_BASE_URL;
  const rawTimeout = env.RAP_ACTIVITY_REST_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout
    ? Number.parseInt(rawTimeout, 10)
    : DEFAULT_RAP_ACTIVITY_REST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    console.warn(
      `rap-client: invalid RAP_ACTIVITY_REST_TIMEOUT_MS "${rawTimeout}" — REST transport disabled`,
    );
    return new FailClosedSubmitter('REST', `invalid RAP_ACTIVITY_REST_TIMEOUT_MS "${rawTimeout}"`);
  }

  try {
    return new RapActivityRestClient({ baseUrl, token, timeoutMs });
  } catch (error) {
    console.warn(
      `rap-client: failed to construct the RAP REST client — REST transport disabled: ${describeCause(error)}`,
    );
    return new FailClosedSubmitter('REST', `failed to construct: ${describeCause(error)}`);
  }
}

export function createRapClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RapActivitySubmitter | null {
  // The whole integration stays fully off only in the one case that was already possible before
  // this task: gRPC explicitly disabled AND REST never configured either — same "no reason to
  // construct anything" outcome `RAP_GRPC_ENABLED=false` alone used to produce (`from-env.spec.ts`'s
  // own pre-existing test for that case still holds, restated against the REST var too).
  if (env.RAP_GRPC_ENABLED === 'false' && !env.RAP_ACTIVITY_REST_TOKEN?.trim()) {
    return null;
  }

  const rest = buildRestSubmitter(env);
  const grpc = buildGrpcSubmitter(env);

  // Unrecognised/unset values fall back to REST — this plan's own R1 default — rather than
  // rejecting boot over a typo in a local `.env` file.
  const transportPrimary: RapActivityTransport =
    env.RAP_ACTIVITY_TRANSPORT_PRIMARY?.trim().toUpperCase() === 'GRPC' ? 'GRPC' : 'REST';

  return new ConfigurableRapActivityClient(rest, grpc, transportPrimary);
}
