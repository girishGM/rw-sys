/**
 * T-INT-054 — calls RAP's real, RAP-owned REST option for `SubmitActivity`
 * (`POST /api/v1/activities`, `realtime-activity-processing-service/src/rest/activity-ingest/`),
 * built specifically so this leg has a REST fallback that doesn't need a real mTLS CA/certificate
 * chain provisioned on Render (see that task's own file, "Recommendation", for why REST was chosen
 * over provisioning real certs). Pure transport plumbing only, mirroring the split
 * `rap-progress-client/rest.client.ts` already established for this app's sibling RAP integration:
 * this class does the call and throws typed errors (`errors.ts`) on failure; it is
 * `configurable.client.ts`'s job to catch those and select a fallback.
 *
 * Guarded on RAP's own side by a single shared bearer secret (`ACTIVITY_INGEST_REST_TOKEN`), not a
 * per-caller identity the way gRPC's mTLS client certificate is — so, unlike the gRPC transport,
 * this one cannot resolve `tenantId` from the connection itself and requires it as an explicit
 * request field instead (`types.ts`'s own header on `SubmitActivityRequest.tenantId`).
 */
import {
  RapServiceRequestError,
  RapServiceUnreachableError,
  RapServiceValidationError,
} from './errors';
import type { RapActivitySubmitter, SubmitActivityRequest, SubmitActivityResponse } from './types';

type FetchLike = typeof fetch;

export interface RapActivityRestClientConfig {
  /** e.g. `http://localhost:3020` — RAP's own `PORT` default (the always-on HTTP process this
   * route is registered on, `activity-ingest-rest.module.ts`'s own header). No trailing slash
   * required, one is stripped if present. */
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
  /** Injectable for tests. */
  readonly fetchImpl?: FetchLike;
}

/** Mirrors `client.ts`'s own `validateSubmitActivityRequest` (the exact required-field rules RAP's
 * real controller enforces) plus this transport's own extra requirement: `tenantId`, which the
 * gRPC transport never needs (it resolves tenant from the mTLS client certificate instead). Returns
 * the first violation found, or `null` when the request is well-formed for this transport. */
export function validateSubmitActivityRequestForRest(
  request: SubmitActivityRequest,
): string | null {
  if (request.tenantId === undefined) {
    return 'tenantId is required for the REST transport';
  }
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
  return null;
}

export class RapActivityRestClient implements RapActivitySubmitter {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: RapActivityRestClientConfig) {
    if (config.baseUrl.trim().length === 0) {
      throw new Error('RapActivityRestClient: baseUrl is required');
    }
    if (config.token.trim().length === 0) {
      throw new Error('RapActivityRestClient: token is required');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async submitActivity(request: SubmitActivityRequest): Promise<SubmitActivityResponse> {
    const validationError = validateSubmitActivityRequestForRest(request);
    if (validationError) {
      throw new RapServiceValidationError(validationError);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/v1/activities`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new RapServiceUnreachableError(`${this.baseUrl}/api/v1/activities`, cause);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new RapServiceRequestError(response.status, await readBody(response));
    }
    return (await response.json()) as SubmitActivityResponse;
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}
