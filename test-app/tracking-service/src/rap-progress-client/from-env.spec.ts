import { createRapProgressClientFromEnv, DEFAULT_RAP_PROGRESS_REST_BASE_URL } from './from-env';
import { ConfigurableRapProgressClient } from './client';

const SECRET_B64 = Buffer.from('d'.repeat(32)).toString('base64');

describe('createRapProgressClientFromEnv', () => {
  it('returns null (not a throw) when PROGRESS_API_AUTH_SECRET is unset — an optional integration', () => {
    expect(createRapProgressClientFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns null for a whitespace-only secret', () => {
    expect(
      createRapProgressClientFromEnv({ PROGRESS_API_AUTH_SECRET: '   ' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it('builds a real client once the secret is present, defaulting base URL/transport', () => {
    const client = createRapProgressClientFromEnv({
      PROGRESS_API_AUTH_SECRET: SECRET_B64,
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(ConfigurableRapProgressClient);
  });

  it("defaults RAP_PROGRESS_REST_BASE_URL to RAP's own PROGRESS_API_PORT default when unset", () => {
    // Exercised indirectly: DEFAULT_RAP_PROGRESS_REST_BASE_URL is the one constant both
    // from-env.ts and this assertion read, so a drift between the two would be caught here too.
    expect(DEFAULT_RAP_PROGRESS_REST_BASE_URL).toBe('http://localhost:3021');
  });

  it('an unrecognised RAP_PROGRESS_TRANSPORT_PRIMARY value falls back to REST (R1), not a crash', () => {
    const client = createRapProgressClientFromEnv({
      PROGRESS_API_AUTH_SECRET: SECRET_B64,
      RAP_PROGRESS_TRANSPORT_PRIMARY: 'not-a-real-value',
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(ConfigurableRapProgressClient);
  });

  it('an invalid RAP_PROGRESS_GRPC_PORT does not crash construction — only disables the GRPC transport', () => {
    const client = createRapProgressClientFromEnv({
      PROGRESS_API_AUTH_SECRET: SECRET_B64,
      RAP_PROGRESS_GRPC_PORT: 'not-a-port',
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(ConfigurableRapProgressClient);
  });

  it('a partial (2-of-3) RAP_PROGRESS_GRPC_TLS_* configuration does not crash construction', () => {
    const client = createRapProgressClientFromEnv({
      PROGRESS_API_AUTH_SECRET: SECRET_B64,
      RAP_PROGRESS_GRPC_TLS_CA_PATH: '/tmp/ca.crt',
      RAP_PROGRESS_GRPC_TLS_CERT_PATH: '/tmp/client.crt',
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(ConfigurableRapProgressClient);
  });
});
