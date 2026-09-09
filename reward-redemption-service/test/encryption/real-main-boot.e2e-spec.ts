import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

/**
 * T-RR-050 regression test. Reproduces the *documented* boot flow — `npm run start:dev` /
 * `node dist/main.js`, run from a genuinely clean shell with nothing pre-exported — as literally
 * as a Jest spec can: this spawns a real, separate `ts-node` subprocess with an explicit,
 * minimal `env` (only `PATH`/`NODE_ENV`/a throwaway `PORT`), so it relies entirely on this
 * service's own checked-in `.env.development` for `FIELD_ENCRYPTION_AES_KEY`,
 * `FIELD_ENCRYPTION_HMAC_KEY` and `CACHE_ADMIN_TOKEN` — none of which are ever placed in the
 * child's `env` object here.
 *
 * This is deliberately NOT masked by Jest's own `test/database/env.setup.ts` the way an
 * in-process `Test.createTestingModule(...)` spec would be: `env.setup.ts` only populates *this*
 * (the Jest parent) process's `process.env`, and `spawn(..., { env })` below replaces the child's
 * environment entirely rather than inheriting it — the exact gap that let this bug go unnoticed by
 * `npm test` since T-RR-005 (see `src/config/load-dotenv-files.ts`'s own header for the full
 * root-cause writeup).
 *
 * **Proven red on the pre-fix code**: reverting `src/main.ts`'s `loadDotenvFilesIntoProcessEnv()`
 * call (T-RR-050) reproduces exactly the reported crash — `FIELD_ENCRYPTION_AES_KEY is required`,
 * process exits non-zero — recorded in this task's own completion report, not re-derived here as a
 * conditional test-time toggle (AGENT-PROTOCOL.md §3: never weaken a guard, and don't grow
 * production code a second, test-only code path just to flip it back and forth).
 *
 * Asserts the *outcome* (AGENT-PROTOCOL.md §3) — a real HTTP request to a real, separately
 * spawned process's `/health` endpoint answering `200` — not an implementation string.
 */
const SERVICE_ROOT = path.join(__dirname, '..', '..');
const TS_NODE_BIN = path.join(SERVICE_ROOT, 'node_modules', '.bin', 'ts-node');
const MAIN_ENTRY = path.join(SERVICE_ROOT, 'src', 'main.ts');
// Deliberately not 3030 (`.env.development`'s own default) — avoids colliding with a developer's
// own already-running `npm run start:dev` instance on this machine.
const PORT = '3999';

interface BootOutcome {
  /** The child process exited (crashed) before we ever observed a healthy `/health` response. */
  crashed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** A real `GET /health` against the spawned child answered `200 { status: 'ok' }`. */
  healthOk: boolean;
}

function waitForHealthOrExit(
  child: ChildProcessWithoutNullStreams,
  port: string,
  timeoutMs: number,
): Promise<BootOutcome> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (outcome: BootOutcome) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      resolve(outcome);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      finish({ crashed: true, exitCode: code, stdout, stderr, healthOk: false });
    });

    const pollTimer = setInterval(() => {
      const req = http.get(
        { host: 'localhost', port: Number(port), path: '/health', timeout: 500 },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            if (res.statusCode === 200) {
              finish({
                crashed: false,
                exitCode: null,
                stdout: stdout + body,
                stderr,
                healthOk: true,
              });
            }
          });
        },
      );
      req.on('error', () => {
        // Not up yet (ECONNREFUSED while Nest is still bootstrapping) — keep polling.
      });
    }, 300);

    const timeoutTimer = setTimeout(() => {
      finish({ crashed: false, exitCode: null, stdout, stderr, healthOk: false });
    }, timeoutMs);
  });
}

describe('real src/main.ts boot, against only .env.development (T-RR-050)', () => {
  let child: ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    child?.kill('SIGKILL');
    child = undefined;
  });

  it(
    'boots via the documented npm-run-start:dev flow and GET /health answers 200, with ' +
      'FIELD_ENCRYPTION_*/CACHE_ADMIN_TOKEN supplied ONLY by .env.development (never pre-exported)',
    async () => {
      child = spawn(TS_NODE_BIN, ['-T', '-r', 'tsconfig-paths/register', MAIN_ENTRY], {
        cwd: SERVICE_ROOT,
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'development',
          PORT,
        },
      });

      const outcome = await waitForHealthOrExit(child, PORT, 20_000);

      // On failure, Jest prints this whole message — including the crashed subprocess's own
      // stderr (e.g. "FIELD_ENCRYPTION_AES_KEY is required...") — rather than just `false !== true`.
      if (outcome.crashed || !outcome.healthOk) {
        throw new Error(
          `Expected src/main.ts to boot and answer GET /health, but it did not ` +
            `(crashed=${outcome.crashed}, exitCode=${outcome.exitCode}).\n--- stdout ---\n` +
            `${outcome.stdout}\n--- stderr ---\n${outcome.stderr}`,
        );
      }

      expect(outcome.crashed).toBe(false);
      expect(outcome.healthOk).toBe(true);
    },
    25_000,
  );
});
