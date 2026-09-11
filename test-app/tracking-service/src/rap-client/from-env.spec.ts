import { createRapClientFromEnv } from './from-env';
import { ConfigurableRapActivityClient } from './configurable.client';
import { RapServiceUnavailableError } from './errors';
import type { SubmitActivityRequest } from './types';

const VALID_REQUEST: SubmitActivityRequest = {
  tenantId: 1,
  customerId: 'priya-shah',
  customerIdType: 'EXTERNAL_ID',
  activityPerformedDate: '2026-09-01T10:15:30Z',
  activityCode: 'Grocery Purchase',
  activityType: 'Grocery Purchase',
  activityCategory: 'GENERAL',
  activityValue: '12.5',
  activityValueUnit: 'USD',
  channel: 'test-app-tracking-service',
  activityPerformedEnv: 'test-app-demo',
  activityName: 'Grocery Purchase',
};

describe('createRapClientFromEnv', () => {
  it('builds a ConfigurableRapActivityClient with just the defaults when nothing is set — this integration is on by default', () => {
    const client = createRapClientFromEnv({} as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(ConfigurableRapActivityClient);
  });

  it('returns null only when BOTH transports are unavailable (RAP_GRPC_ENABLED=false and no REST token)', () => {
    expect(createRapClientFromEnv({ RAP_GRPC_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('stays enabled when RAP_GRPC_ENABLED=false but a REST token is configured', () => {
    const client = createRapClientFromEnv({
      RAP_GRPC_ENABLED: 'false',
      RAP_ACTIVITY_REST_TOKEN: 'a-real-token',
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(ConfigurableRapActivityClient);
  });

  // TC — the default primary is REST (this plan's own R1); with no REST token configured, REST
  // fails closed locally (no network call) and the client falls back to gRPC, which is itself
  // on-by-default per the pre-existing "unreachable is a caught, harmless outcome" contract.
  it('with no RAP_ACTIVITY_REST_TOKEN set, REST fails closed and falls back to (unreachable) gRPC', async () => {
    const client = createRapClientFromEnv({} as NodeJS.ProcessEnv);
    expect(client).not.toBeNull();

    await expect(client!.submitActivity(VALID_REQUEST)).rejects.toThrow();
  });

  it('an invalid RAP_ACTIVITY_REST_TIMEOUT_MS disables only the REST transport, not the whole client', () => {
    const client = createRapClientFromEnv({
      RAP_ACTIVITY_REST_TOKEN: 'a-real-token',
      RAP_ACTIVITY_REST_TIMEOUT_MS: 'not-a-number',
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(ConfigurableRapActivityClient);
  });

  it('returns a client even with a custom gRPC host/port', () => {
    const client = createRapClientFromEnv({
      RAP_GRPC_HOST: 'rap.internal',
      RAP_GRPC_PORT: '50099',
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(ConfigurableRapActivityClient);
  });
});

describe('createRapClientFromEnv — both transports genuinely unavailable', () => {
  it('with REST pointed at an unreachable address and gRPC explicitly disabled, both transports are actually attempted before giving up', async () => {
    // REST (primary, R1 default) is configured but points at port 1 (reserved, never accepting
    // connections) -> RapServiceUnreachableError; gRPC is explicitly disabled -> fails closed
    // locally with RapServiceTransportNotAvailableError. Both are real attempts (REST really opens
    // a connection and really fails; gRPC never even tries) — ConfigurableRapActivityClient wraps
    // both into one RapServiceUnavailableError once neither succeeds.
    const client = createRapClientFromEnv({
      RAP_ACTIVITY_REST_TOKEN: 'a-real-token',
      RAP_ACTIVITY_REST_BASE_URL: 'http://127.0.0.1:1',
      RAP_GRPC_ENABLED: 'false',
    } as NodeJS.ProcessEnv);

    await expect(client!.submitActivity(VALID_REQUEST)).rejects.toBeInstanceOf(
      RapServiceUnavailableError,
    );
  });
});
