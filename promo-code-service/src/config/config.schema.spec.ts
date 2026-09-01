import { validateConfig } from './config.schema';

describe('validateConfig', () => {
  const FULL_ENV = {
    DB_HOST: 'localhost',
    DB_NAME: 'reward_system',
    DB_APP_USERNAME: 'promo_code_app',
    DB_APP_PASSWORD: 'throwaway-local-dev-value',
    DB_MIGRATION_USERNAME: 'postgres',
    DB_MIGRATION_PASSWORD: 'throwaway-local-dev-value',
    KAFKA_BROKERS: 'localhost:9092',
  };

  function withExitAndConsoleMocked(fn: () => void): {
    exitSpy: jest.SpyInstance;
    errorSpy: jest.SpyInstance;
  } {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit called');
    }) as never);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fn();
    return { exitSpy, errorSpy };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // TC-2 (typecheck/lint pass on this file is proven by the lint/typecheck gates; this case
  // proves the *behaviour* those gates can't: a fully-populated environment is accepted and
  // the documented defaults (NODE_ENV, PORT, DB_PORT) are actually applied by zod, not just
  // declared in the schema's source text.
  it('accepts a fully-populated environment and applies the documented defaults', () => {
    const result = validateConfig(FULL_ENV);
    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe(3010);
    expect(result.DB_PORT).toBe(5432);
    expect(result.DB_APP_USERNAME).toBe('promo_code_app');
  });

  it('coerces DB_SSL="true" to boolean true and anything else to false', () => {
    expect(validateConfig({ ...FULL_ENV, DB_SSL: 'true' }).DB_SSL).toBe(true);
    expect(validateConfig({ ...FULL_ENV, DB_SSL: 'false' }).DB_SSL).toBe(false);
    expect(validateConfig(FULL_ENV).DB_SSL).toBe(false);
  });

  // TC-4: "Boot main.ts with a required env var (e.g. DB_PASSWORD) unset" — exercised here
  // against the actual required field this schema declares, DB_APP_PASSWORD. Asserts the
  // real, observable failure behaviour (process.exit(1) called, stderr names the missing
  // field) rather than restating the schema's own source as a string.
  it('exits non-zero with a config error naming the missing field when DB_APP_PASSWORD is unset', () => {
    const { DB_APP_PASSWORD: _omit, ...incomplete } = FULL_ENV;
    let thrown: unknown;
    const { exitSpy, errorSpy } = withExitAndConsoleMocked(() => {
      try {
        validateConfig(incomplete);
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DB_APP_PASSWORD'));
  });

  it('exits non-zero with a config error naming the missing field when KAFKA_BROKERS is unset', () => {
    const { KAFKA_BROKERS: _omit, ...incomplete } = FULL_ENV;
    let thrown: unknown;
    const { exitSpy, errorSpy } = withExitAndConsoleMocked(() => {
      try {
        validateConfig(incomplete);
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('KAFKA_BROKERS'));
  });

  it('rejects an out-of-enum NODE_ENV rather than silently accepting it', () => {
    let thrown: unknown;
    const { exitSpy } = withExitAndConsoleMocked(() => {
      try {
        validateConfig({ ...FULL_ENV, NODE_ENV: 'staging' });
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(Error);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
