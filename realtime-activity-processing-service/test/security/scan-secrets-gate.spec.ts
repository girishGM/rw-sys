/**
 * T-RAP-042 — TC-5 / Verification step 2. Proves `npm run scan:secrets` is not just "currently
 * green" but actually *works* — i.e. would catch a real, planted secret — the same proof pattern
 * `promo-code-service`'s own T-PC-001 verification established (this task's own Verification step
 * 2 names it explicitly). A gate nobody has ever seen fail is not a gate that has been proven to
 * fire; this plants a real fixture, observes the script actually reject it, then removes it and
 * confirms the tree is clean again.
 *
 * Runs the real `scripts/scan-secrets.sh` as a subprocess (not a re-implementation of its regex in
 * this test) — the point is to exercise exactly what `npm run scan:secrets` runs in CI/pre-commit.
 *
 * **Why the fixture is `git add`-ed, not just written to disk.** This repo's own working tree has
 * a large amount of pre-existing staged (`git add`-ed, uncommitted) work at the time this task was
 * written — confirmed directly (`git status --short`) rather than assumed. `scan-secrets.sh`'s own
 * documented precedence ("prefer staged files during a pre-commit hook") means that whenever
 * *anything* is staged, it scans **only** the staged file list, not the full working tree — so an
 * untracked-but-unstaged fixture would silently never be scanned at all in that state, which this
 * test discovered by first trying exactly that and observing a false "clean" result. Staging the
 * fixture (`git add`, then `git reset --` to unstage it again in `afterEach`, never a destructive
 * op) is what actually reproduces the real pre-commit-hook code path.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SERVICE_ROOT = join(__dirname, '..', '..');
const SCRIPT_PATH = join(SERVICE_ROOT, 'scripts', 'scan-secrets.sh');
// Deliberately NOT `.env.*`-shaped (root .gitignore's `.env.*` would hide it from
// `git ls-files --others --exclude-standard`, which is exactly what the script falls back to
// scanning when nothing is staged) and not one of `scan-secrets.sh`'s own always-skipped
// extensions (`.env.example`, `*.spec.ts`, ...).
const FIXTURE_PATH = join(SERVICE_ROOT, 't-rap-042-scan-secrets-fixture.txt');

interface RunResult {
  exitCode: number;
  output: string;
}

function runScanSecrets(): RunResult {
  try {
    const output = execFileSync('bash', [SCRIPT_PATH], { cwd: SERVICE_ROOT, encoding: 'utf8' });
    return { exitCode: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function unstageAndRemoveFixture(): void {
  if (existsSync(FIXTURE_PATH)) {
    try {
      execFileSync('git', ['reset', '--', FIXTURE_PATH], { cwd: SERVICE_ROOT });
    } catch {
      // Nothing staged to unstage — fine, fall through to the unconditional rm below.
    }
    rmSync(FIXTURE_PATH);
  }
}

describe('T-RAP-042 TC-5 / Verification step 2 — scan:secrets actually catches a planted secret', () => {
  afterEach(() => {
    unstageAndRemoveFixture();
  });

  it('is clean against the real, current working tree', () => {
    expect(existsSync(FIXTURE_PATH)).toBe(false);
    const result = runScanSecrets();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('clean');
  });

  it('rejects a deliberately planted, staged fixture secret, then is clean again once removed', () => {
    writeFileSync(FIXTURE_PATH, 'DB_PASSWORD=SuperSecretPlantedFixtureValue123\n');
    execFileSync('git', ['add', FIXTURE_PATH], { cwd: SERVICE_ROOT });

    const dirty = runScanSecrets();
    expect(dirty.exitCode).not.toBe(0);
    expect(dirty.output).toContain('t-rap-042-scan-secrets-fixture.txt');

    unstageAndRemoveFixture();

    const cleanAgain = runScanSecrets();
    expect(cleanAgain.exitCode).toBe(0);
    expect(cleanAgain.output).toContain('clean');
  });
});
