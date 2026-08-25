/**
 * T-066 TC-9, the *runtime* half — does the variable actually arrive through the real
 * `@nestjs/config` pipeline, from a real `.env` file, into a real `ConfigService`?
 *
 * `login-throttle-env.spec.ts` proves the zod half: `validateEnv` keeps
 * `LOGIN_THROTTLE_RELAX_FACTOR` in its output and strips an undeclared sibling. That is necessary
 * but **not sufficient**, and the difference is the whole reason this file exists. Every other
 * T-066 test — including that one — supplies a *fake* `ConfigService` built from a plain object.
 * None of them exercises the chain the deployed application actually runs:
 *
 *   `.env` file → dotenv parse → `validateEnv` (zod, strips unknown keys)
 *               → `assignVariablesToProcess` → `ConfigService.get`
 *
 * T-066's implementation note 2 says in as many words: *"Verify by observing the value at boot,
 * not by reading the code."* A fake `ConfigService` cannot observe that, because it *is* the thing
 * under test replaced by a stub. This spec uses `ConfigModule.forRoot` with the **real**
 * `validateEnv` and a **real** temporary file on disk, so the assertion is about what the
 * framework does, not about what we believe it does.
 *
 * Why this is not redundant with the zod test: the two fail independently. Declaring the key in
 * `envSchema` but reading it under a different name, or a future `.strict()`/`.strip()` change, or
 * a change to how `@nestjs/config` assigns validated output back, would each leave the zod test
 * green and break this one. That asymmetry is what AGENT-PROTOCOL §3 asks for.
 *
 * No secret is written to disk (R4): every value below is a syntactically valid placeholder
 * consumed only by zod's `.min(1)`, in a file created under the OS temp directory and removed in
 * `afterAll`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { validateEnv, type Env } from '@/config/env.schema';
import {
  LOGIN_THROTTLE_RELAX_FACTOR_VAR,
  resolveLoginThrottleLimits,
} from '@/common/security/security.constants';

/** Required keys, so the real `validateEnv` cannot reach its `process.exit(1)` branch. */
const REQUIRED_ENV_LINES = [
  'JWT_PRIVATE_KEY=placeholder-not-a-key',
  'JWT_PUBLIC_KEY=placeholder-not-a-key',
  'DB_HOST=localhost',
  'DB_NAME=placeholder',
  'DB_APP_USERNAME=placeholder',
  'DB_APP_PASSWORD=placeholder',
  'DB_MIGRATION_USERNAME=placeholder',
  'DB_MIGRATION_PASSWORD=placeholder',
];

let tempDir: string;
let envSnapshot: NodeJS.ProcessEnv;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 't066-env-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * `process.env` is snapshotted and restored around every case, and that is not boilerplate — it
 * is a direct consequence of the behaviour this file exists to pin down.
 *
 * When a `validate` function is supplied, `@nestjs/config` calls `assignVariablesToProcess` on the
 * validated result, which **mutates the real `process.env` of the Jest worker**. Without this
 * reset, the `LOGIN_THROTTLE_RELAX_FACTOR=8` written by an earlier case is still present for a
 * later one, and the "no override at all" case reads `8` from a file that never mentioned it.
 * That was observed here, not theorised: this suite failed exactly that way before the reset was
 * added. Restoring per case keeps each assertion about the file it was given.
 */
beforeEach(() => {
  envSnapshot = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
});

/**
 * Writes a real `.env` file and boots a real `ConfigModule` over it.
 *
 * `ignoreEnvVars: true` keeps the ambient process environment out of the result, so what comes
 * back is unambiguously what the *file* supplied — otherwise a value leaking in from the shell
 * could make this pass for the wrong reason.
 */
async function bootConfigFromFile(lines: readonly string[]): Promise<ConfigService<Env, true>> {
  const envFilePath = join(tempDir, `${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(envFilePath, [...REQUIRED_ENV_LINES, ...lines].join('\n'), 'utf8');

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: false,
        validate: validateEnv,
        envFilePath,
        ignoreEnvVars: true,
      }),
    ],
  }).compile();

  return moduleRef.get<ConfigService<Env, true>>(ConfigService);
}

describe('T-066 TC-9 — the override survives the real @nestjs/config pipeline', () => {
  it('serves a value written in a .env file through ConfigService', async () => {
    const config = await bootConfigFromFile(['NODE_ENV=test', 'LOGIN_THROTTLE_RELAX_FACTOR=8']);

    // The observation the task asks for: not "the schema mentions it", but "the running
    // application can read it". This is the exact call SecurityModule's factory makes.
    expect(config.get(LOGIN_THROTTLE_RELAX_FACTOR_VAR, { infer: true })).toBe('8');
  });

  it('negative control: an undeclared variable in the same file is NOT served', async () => {
    // Proves the assertion above is load-bearing. If the pipeline passed everything through,
    // the first test would pass even with the key missing from envSchema — this one would not.
    const config = await bootConfigFromFile([
      'NODE_ENV=test',
      'SOME_UNDECLARED_T066_VARIABLE=present-in-the-file',
    ]);

    expect(config.get('SOME_UNDECLARED_T066_VARIABLE' as keyof Env)).toBeUndefined();
  });

  it('feeds SecurityModule’s resolution path end to end, from file to resolved limits', async () => {
    const config = await bootConfigFromFile(['NODE_ENV=test', 'LOGIN_THROTTLE_RELAX_FACTOR=8']);

    // Exactly what SecurityModule's useFactory does, with a real ConfigService behind it.
    const limits = resolveLoginThrottleLimits({
      raw: config.get(LOGIN_THROTTLE_RELAX_FACTOR_VAR, { infer: true }),
      nodeEnv: config.get('NODE_ENV', { infer: true }),
    });

    expect(limits.relaxed).toBe(true);
    expect(limits.perEmailIp).toBe(40);
    expect(limits.perIp).toBe(160);
  });

  it('resolves to production limits from a file that sets NODE_ENV=production', async () => {
    // TC-4 through the real pipeline rather than the pure function: a deployed production process
    // reading a file that sets the knob must still get 5 / 20.
    const config = await bootConfigFromFile([
      'NODE_ENV=production',
      'LOGIN_THROTTLE_RELAX_FACTOR=40',
    ]);

    const limits = resolveLoginThrottleLimits({
      raw: config.get(LOGIN_THROTTLE_RELAX_FACTOR_VAR, { infer: true }),
      nodeEnv: config.get('NODE_ENV', { infer: true }),
    });

    expect(limits.relaxed).toBe(false);
    expect(limits.perEmailIp).toBe(5);
    expect(limits.perIp).toBe(20);
  });

  it('a file with no override at all yields the production policy', async () => {
    const config = await bootConfigFromFile(['NODE_ENV=test']);

    expect(config.get(LOGIN_THROTTLE_RELAX_FACTOR_VAR, { infer: true })).toBeUndefined();

    const limits = resolveLoginThrottleLimits({
      raw: config.get(LOGIN_THROTTLE_RELAX_FACTOR_VAR, { infer: true }),
      nodeEnv: config.get('NODE_ENV', { infer: true }),
    });

    expect(limits.perEmailIp).toBe(5);
    expect(limits.relaxed).toBe(false);
  });
});
