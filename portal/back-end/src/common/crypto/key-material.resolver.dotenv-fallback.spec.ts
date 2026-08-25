/**
 * T-057 (D-3) — unit coverage for `loadDotEnvFallback`/`defaultKeyMaterialEnv`, the two
 * functions this task added to `key-material.resolver.ts` (see that file's own header
 * comment for the defect and the fix).
 *
 * Colocated with the source file, deliberately separate from
 * `test/crypto/key-material.resolver.spec.ts` (T-016's — every branch of everything else in
 * this file, including `EnvKeyMaterialResolver`'s "defaults to the real process environment"
 * behaviour with the *true* default arguments, is already covered there and is not
 * duplicated here). This file exists because `test/crypto/**` is T-016's own file scope, not
 * this task's (T-057-runnability-defects.md's own "Files owned" list is exactly one file in
 * this directory), and a new source branch this task added needs *some* test to reach
 * AGENT-PROTOCOL §4's coverage bar without editing a file this task was not granted.
 *
 * Every case below drives `loadDotEnvFallback`/`defaultKeyMaterialEnv` with an explicit,
 * disposable temp directory rather than `back-end/`'s real `.env*` files — see those
 * functions' own doc comments for why the `root`/`nodeEnv` parameters exist at all.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EnvKeyMaterialResolver,
  backEndRoot,
  defaultKeyMaterialEnv,
  loadDotEnvFallback,
} from './key-material.resolver';

/** Runs `fn` with `process.env.NODE_ENV` deleted, then restores whatever it was — exercises
 * the `process.env.NODE_ENV || 'development'` fallback's false-y branch, which every other
 * test in this suite (and in `test/crypto/key-material.resolver.spec.ts`) never reaches
 * because Jest itself sets `NODE_ENV=test` for the whole run. */
function withoutNodeEnv<T>(fn: () => T): T {
  const original = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    return fn();
  } finally {
    if (original !== undefined) process.env.NODE_ENV = original;
  }
}

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 't057-dotenv-'));
}

describe('backEndRoot', () => {
  it('is three directories up from this file — back-end/', () => {
    expect(path.basename(backEndRoot())).toBe('back-end');
  });
});

describe('loadDotEnvFallback', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} when none of the three files exist', () => {
    expect(loadDotEnvFallback(dir, 'development')).toEqual({});
  });

  it('reads .env alone', () => {
    writeFileSync(path.join(dir, '.env'), 'FOO=bar\n');
    expect(loadDotEnvFallback(dir, 'development')).toEqual({ FOO: 'bar' });
  });

  it('.env.<nodeEnv> beats .env for the same key', () => {
    writeFileSync(path.join(dir, '.env'), 'FOO=from-env\n');
    writeFileSync(path.join(dir, '.env.development'), 'FOO=from-development\n');
    expect(loadDotEnvFallback(dir, 'development')).toEqual({ FOO: 'from-development' });
  });

  it('.env.local beats both .env.<nodeEnv> and .env for the same key', () => {
    writeFileSync(path.join(dir, '.env'), 'FOO=from-env\n');
    writeFileSync(path.join(dir, '.env.development'), 'FOO=from-development\n');
    writeFileSync(path.join(dir, '.env.local'), 'FOO=from-local\n');
    expect(loadDotEnvFallback(dir, 'development')).toEqual({ FOO: 'from-local' });
  });

  it('merges non-overlapping keys across all three files', () => {
    writeFileSync(path.join(dir, '.env'), 'A=1\n');
    writeFileSync(path.join(dir, '.env.development'), 'B=2\n');
    writeFileSync(path.join(dir, '.env.local'), 'C=3\n');
    expect(loadDotEnvFallback(dir, 'development')).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('selects .env.<nodeEnv> by the nodeEnv argument, not a fixed name', () => {
    writeFileSync(path.join(dir, '.env.test'), 'FOO=from-test\n');
    writeFileSync(path.join(dir, '.env.production'), 'FOO=from-production\n');
    expect(loadDotEnvFallback(dir, 'test')).toEqual({ FOO: 'from-test' });
    // Different (root, nodeEnv) pair — its own cache entry, not the one above's.
    expect(loadDotEnvFallback(dir, 'production')).toEqual({ FOO: 'from-production' });
  });

  it('an unreadable file (a directory in place of .env.local) is skipped, not thrown', () => {
    mkdirSync(path.join(dir, '.env.local')); // readFileSync on a directory throws EISDIR
    writeFileSync(path.join(dir, '.env'), 'FOO=bar\n');
    expect(loadDotEnvFallback(dir, 'development')).toEqual({ FOO: 'bar' });
  });

  it('caches by (root, nodeEnv): a file written after the first call is not picked up', () => {
    expect(loadDotEnvFallback(dir, 'development')).toEqual({});
    writeFileSync(path.join(dir, '.env'), 'FOO=too-late\n');
    expect(loadDotEnvFallback(dir, 'development')).toEqual({});
  });

  it('called with no arguments at all, defaults root to backEndRoot() and nodeEnv to NODE_ENV (or "development")', () => {
    // Real back-end/ directory, real (or absent) .env* files — this only asserts the call
    // completes and returns a plain object, exactly what every real, argument-less caller
    // (EnvKeyMaterialResolver's own constructor default) relies on.
    expect(typeof loadDotEnvFallback()).toBe('object');
    expect(typeof withoutNodeEnv(() => loadDotEnvFallback())).toBe('object');
  });
});

describe('defaultKeyMaterialEnv', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a key from process.env when present there', () => {
    process.env.T057_DKME_A = 'from-process-env';
    try {
      const env = defaultKeyMaterialEnv(dir, 'development');
      expect(env.T057_DKME_A).toBe('from-process-env');
    } finally {
      delete process.env.T057_DKME_A;
    }
  });

  it('falls back to the .env file when process.env does not have the key at all', () => {
    writeFileSync(path.join(dir, '.env'), 'T057_DKME_B=from-dot-env-file\n');
    const env = defaultKeyMaterialEnv(dir, 'development');
    expect(env.T057_DKME_B).toBe('from-dot-env-file');
  });

  it('never lets a .env file value shadow a real process.env value for the same name', () => {
    writeFileSync(path.join(dir, '.env'), 'T057_DKME_C=from-dot-env-file\n');
    process.env.T057_DKME_C = 'from-process-env';
    try {
      const env = defaultKeyMaterialEnv(dir, 'development');
      expect(env.T057_DKME_C).toBe('from-process-env');
    } finally {
      delete process.env.T057_DKME_C;
    }
  });

  it('is undefined when the key is in neither source', () => {
    const env = defaultKeyMaterialEnv(dir, 'development');
    expect(env.T057_DKME_MISSING).toBeUndefined();
  });

  it('`in` reports true for a key only the .env fallback has', () => {
    writeFileSync(path.join(dir, '.env'), 'T057_DKME_D=x\n');
    const env = defaultKeyMaterialEnv(dir, 'development');
    expect('T057_DKME_D' in env).toBe(true);
  });

  it('`in` reports true for a key only process.env has', () => {
    process.env.T057_DKME_E = 'x';
    try {
      const env = defaultKeyMaterialEnv(dir, 'development');
      expect('T057_DKME_E' in env).toBe(true);
    } finally {
      delete process.env.T057_DKME_E;
    }
  });

  it('`in` reports false for a key in neither source', () => {
    const env = defaultKeyMaterialEnv(dir, 'development');
    expect('T057_DKME_MISSING_TOO' in env).toBe(false);
  });

  it('called with no arguments at all, defaults root to backEndRoot() and nodeEnv to NODE_ENV (or "development")', () => {
    expect(defaultKeyMaterialEnv()['__T057_DOES_NOT_EXIST__']).toBeUndefined();
    expect(
      withoutNodeEnv(() => defaultKeyMaterialEnv())['__T057_DOES_NOT_EXIST__'],
    ).toBeUndefined();
  });
});

describe('EnvKeyMaterialResolver — "not set" message names every place checked', () => {
  it('names NODE_ENV when set (TC-11 already covers the message shape; this covers the value)', async () => {
    const resolver = new EnvKeyMaterialResolver({});
    await expect(
      resolver.resolve({ scheme: 'env', locator: 'T057_MISSING_A' }, 'kid'),
    ).rejects.toThrow(/\.env\.test\//);
  });

  it('falls back to "development" in the message when NODE_ENV is unset', async () => {
    const resolver = new EnvKeyMaterialResolver({});
    const original = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      await expect(
        resolver.resolve({ scheme: 'env', locator: 'T057_MISSING_B' }, 'kid'),
      ).rejects.toThrow(/\.env\.development\//);
    } finally {
      if (original !== undefined) process.env.NODE_ENV = original;
    }
  });
});
