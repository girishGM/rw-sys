import { createRapClientFromEnv } from './from-env';
import { RapActivityClient } from './client';

describe('createRapClientFromEnv', () => {
  it('builds a RapActivityClient with just the defaults when no RAP_GRPC_* vars are set — this integration is on by default', () => {
    const client = createRapClientFromEnv({} as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(RapActivityClient);
  });

  it('returns null when RAP_GRPC_ENABLED is explicitly "false"', () => {
    expect(createRapClientFromEnv({ RAP_GRPC_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns null (not a throw) for an invalid RAP_GRPC_PORT', () => {
    expect(createRapClientFromEnv({ RAP_GRPC_PORT: 'not-a-port' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns null for an invalid RAP_GRPC_TIMEOUT_MS', () => {
    expect(createRapClientFromEnv({ RAP_GRPC_TIMEOUT_MS: '-5' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns null when only some of the three RAP_GRPC_TLS_* vars are set', () => {
    expect(
      createRapClientFromEnv({
        RAP_GRPC_TLS_CA_PATH: '/tmp/ca.pem',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('returns null when TLS material is configured but unreadable', () => {
    expect(
      createRapClientFromEnv({
        RAP_GRPC_TLS_CA_PATH: '/nonexistent/ca.pem',
        RAP_GRPC_TLS_CERT_PATH: '/nonexistent/cert.pem',
        RAP_GRPC_TLS_KEY_PATH: '/nonexistent/key.pem',
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('builds a client with a custom host/port when both are set', () => {
    const client = createRapClientFromEnv({
      RAP_GRPC_HOST: 'rap.internal',
      RAP_GRPC_PORT: '50099',
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(RapActivityClient);
  });
});
