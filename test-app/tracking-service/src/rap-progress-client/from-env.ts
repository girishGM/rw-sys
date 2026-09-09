/**
 * T-INT-021 — builds a {@link RapProgressReader} from `RAP_PROGRESS_*`/`PROGRESS_API_AUTH_SECRET`
 * (`.env.example`), or returns `null` when the shared secret is unset.
 *
 * **Defaulting philosophy — closer to `rap-client`'s than to `promo-code-client`'s (this task's
 * own Implementation note 2).** This is a *read* path a real page (the Dashboard's "Your
 * Progress" widget) depends on to render, not a purely optional side effect — so every var except
 * the secret defaults to RAP's own local-dev values and `RAP_PROGRESS_TRANSPORT_PRIMARY` defaults
 * to `REST` (this plan's own R1: REST is the default primary everywhere right now). The one thing
 * that genuinely cannot have a safe built-in default is `PROGRESS_API_AUTH_SECRET` — a real
 * cryptographic secret shared with RAP's own `ProgressApiAuthGuard`/`ProgressQueryController`,
 * never invented or committed (R4). Its absence degrades this integration to `null` (the same
 * "optional integration, never breaks boot" contract `reward-tracking-client`/`promo-code-client`
 * already established) rather than failing loudly the way RAP's own `loadProgressApiAuthSecret`
 * does for itself — this is a consumer, not that service's own boot path.
 *
 * A bad/partial gRPC TLS configuration disables only the gRPC transport (via
 * {@link FailClosedProgressReader}), not the whole integration — REST stays usable even if a
 * developer's local gRPC cert setup is wrong, unlike `rap-client/from-env.ts`'s own "disable the
 * whole client" behaviour, which is safe there only because that integration has exactly one
 * transport to begin with.
 */
import { readFileSync } from 'node:fs';
import { ConfigurableRapProgressClient, type RapProgressTransport } from './client';
import { RapProgressTransportNotAvailableError } from './errors';
import {
  DEFAULT_RAP_PROGRESS_GRPC_PORT,
  DEFAULT_RAP_PROGRESS_GRPC_TIMEOUT_MS,
  RapProgressGrpcClient,
  type RapProgressGrpcClientOptions,
} from './grpc.client';
import { RapProgressRestClient } from './rest.client';
import { parseProgressApiAuthSecret } from './token';
import type {
  GetCampaignProgressParams,
  GetTrackerProgressParams,
  RapProgressReader,
} from './types';

export const DEFAULT_RAP_PROGRESS_REST_BASE_URL = 'http://localhost:3021';
export const DEFAULT_RAP_PROGRESS_REST_TIMEOUT_MS = 3_000;

/** Always throws {@link RapProgressTransportNotAvailableError} — used in place of a real gRPC
 * client when `RAP_PROGRESS_GRPC_TLS_*` is present but invalid/unreadable, so a broken local
 * gRPC setup fails that one transport closed rather than crashing this client's construction or
 * silently disabling REST too. */
class FailClosedProgressReader implements RapProgressReader {
  constructor(
    private readonly transport: 'GRPC',
    private readonly reason: string,
  ) {}

  async getCampaignProgress(_params: GetCampaignProgressParams): Promise<never> {
    throw new RapProgressTransportNotAvailableError(this.transport, this.reason);
  }

  async getTrackerProgress(_params: GetTrackerProgressParams): Promise<never> {
    throw new RapProgressTransportNotAvailableError(this.transport, this.reason);
  }
}

function loadGrpcTls(env: NodeJS.ProcessEnv): RapProgressGrpcClientOptions['tls'] | 'invalid' {
  const caPath = env.RAP_PROGRESS_GRPC_TLS_CA_PATH?.trim();
  const certPath = env.RAP_PROGRESS_GRPC_TLS_CERT_PATH?.trim();
  const keyPath = env.RAP_PROGRESS_GRPC_TLS_KEY_PATH?.trim();
  const configuredPaths = [caPath, certPath, keyPath].filter((value) => !!value);
  if (configuredPaths.length === 0) return undefined;
  if (configuredPaths.length < 3) {
    console.warn(
      'rap-progress-client: RAP_PROGRESS_GRPC_TLS_CA_PATH, _CERT_PATH and _KEY_PATH must all be ' +
        'set together, or none of them — the GRPC transport for this leg is disabled',
    );
    return 'invalid';
  }
  try {
    return {
      rootCerts: readFileSync(caPath as string),
      clientCert: readFileSync(certPath as string),
      clientKey: readFileSync(keyPath as string),
    };
  } catch (error) {
    console.warn(
      'rap-progress-client: failed to read RAP_PROGRESS_GRPC_TLS_* certificate material — the ' +
        `GRPC transport for this leg is disabled: ${describeCause(error)}`,
    );
    return 'invalid';
  }
}

function buildGrpcReader(env: NodeJS.ProcessEnv, secret: Buffer): RapProgressReader {
  const host = env.RAP_PROGRESS_GRPC_HOST?.trim() || 'localhost';
  const rawPort = env.RAP_PROGRESS_GRPC_PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_RAP_PROGRESS_GRPC_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    return new FailClosedProgressReader('GRPC', `invalid RAP_PROGRESS_GRPC_PORT "${rawPort}"`);
  }

  const rawTimeout = env.RAP_PROGRESS_GRPC_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout
    ? Number.parseInt(rawTimeout, 10)
    : DEFAULT_RAP_PROGRESS_GRPC_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return new FailClosedProgressReader(
      'GRPC',
      `invalid RAP_PROGRESS_GRPC_TIMEOUT_MS "${rawTimeout}"`,
    );
  }

  const tls = loadGrpcTls(env);
  if (tls === 'invalid') {
    return new FailClosedProgressReader('GRPC', 'invalid RAP_PROGRESS_GRPC_TLS_* configuration');
  }

  try {
    return new RapProgressGrpcClient({ host, port, timeoutMs, secret, tls });
  } catch (error) {
    return new FailClosedProgressReader(
      'GRPC',
      `failed to construct the gRPC client: ${describeCause(error)}`,
    );
  }
}

export function createRapProgressClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RapProgressReader | null {
  const secret = parseProgressApiAuthSecret(env.PROGRESS_API_AUTH_SECRET);
  if (!secret) return null;

  const restBaseUrl = env.RAP_PROGRESS_REST_BASE_URL?.trim() || DEFAULT_RAP_PROGRESS_REST_BASE_URL;
  const restTimeoutMs =
    Number(env.RAP_PROGRESS_REST_TIMEOUT_MS) || DEFAULT_RAP_PROGRESS_REST_TIMEOUT_MS;
  const rest = new RapProgressRestClient({
    baseUrl: restBaseUrl,
    secret,
    timeoutMs: restTimeoutMs,
  });

  const grpc = buildGrpcReader(env, secret);

  // Unrecognised/unset values fall back to REST — this plan's own R1 default — rather than
  // rejecting boot over a typo in a local `.env` file.
  const transportPrimary: RapProgressTransport =
    env.RAP_PROGRESS_TRANSPORT_PRIMARY?.trim().toUpperCase() === 'GRPC' ? 'GRPC' : 'REST';

  return new ConfigurableRapProgressClient(rest, grpc, transportPrimary);
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
