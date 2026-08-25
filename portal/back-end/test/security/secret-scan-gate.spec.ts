/**
 * T-051 TC-23 — **the secret-scan gate, tested rather than trusted.**
 *
 * This file exists because of F-14. `npm run scan:secrets` is the enforcement mechanism for
 * AGENT-PROTOCOL R4 ("No secret in any committed file") and one of the six mandatory §4 completion
 * gates, and for eight days it printed `scan:secrets: clean` while examining **zero files** on
 * every one of its code paths. Five consecutive passes of this audit ticked TC-23 on that output.
 * Nothing in the repository would ever have gone red, because nothing in the repository ran the
 * gate against a file that should fail it.
 *
 * T-089 fixed the script and shipped a `--self-test` of its own. That is good, and it is *not* what
 * this file is: a fixture harness that ships inside the artefact it validates is the same shape of
 * evidence F-14 was — an instrument agreeing with itself. This spec drives the **real script**,
 * from the outside, and asserts the two observable properties a caller actually depends on: the
 * process **exit code**, and whether the offending **file is named** in the output. AGENT-PROTOCOL
 * §3: *"if the specified value were wrong, would this test still pass?"* If the file list ever goes
 * empty again — for any of F-14's three original reasons or a fourth nobody has thought of — cases
 * 1 and 2 below turn red immediately.
 *
 * ### Why a temp fixture repo rather than this repo
 *
 * The gate's behaviour depends on `git`: which files it lists, and whether the staged (pre-commit)
 * path or the working-tree path is taken. Exercising that against the real working tree would mean
 * planting a secret in it and running `git add` — concurrently with whatever other agents are doing
 * in the same checkout, and one interrupted run away from leaving a planted credential behind. The
 * fixture reproduces the one structural detail that mattered to F-14 instead: **the git root one
 * directory above the npm workspace root** (`gitroot/` vs `gitroot/portal/`), which is what made
 * `git diff --cached`'s repo-root-relative paths disagree with the script's own `cd`.
 *
 * The script is copied in, so what runs is the current bytes of `portal/scripts/scan-secrets.sh`,
 * resolved from this file's location — not a re-implementation of it, and not a snapshot.
 *
 * ### Case 4 asserts a policy this audit disagrees with, deliberately
 *
 * T-089's fix also excluded every `test/` and `e2e/` path from the scan (its two glob arms) — 508
 * of the 1,794
 * files it lists in this repo, and the population where a working credential is most likely to be
 * pasted by accident, since `.gitignore` does not cover test files the way it covers `.env*`. That
 * is **F-16** in this task's report: recorded as Low (hand-scanning all 508 found 111 hits, every
 * one a fixture value or a variable reference, and zero copies of the live credential), with the
 * case for narrowing it written out there.
 *
 * Case 4 pins the exclusion **as built**, for the same reason the F-13 probe in
 * `layer-two-exposure.e2e-spec.ts` pins the management floor as built: the policy is currently
 * written down nowhere else, and a test that asserts it turns red the moment someone changes it —
 * which routes that person to F-16 instead of rediscovering it a third time. It is a
 * change-detector by construction, and it is labelled as one rather than dressed up as a security
 * assertion.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** `portal/scripts/scan-secrets.sh`, resolved from this spec rather than hardcoded. */
const SCRIPT = resolve(__dirname, '../../../scripts/scan-secrets.sh');

/**
 * The secret line the fixtures carry, assembled at runtime.
 *
 * Deliberately never spelled out as one literal: this spec is itself a file in the tree the gate
 * scans, and it sits in `test/` — which case 4 proves is currently excluded. If that exclusion is
 * ever narrowed (which F-16 argues for), a literal here would make **this file** the first thing
 * the newly-widened scan flags. T-089's own harness avoids the same trap the same way.
 */
const SECRET_LINE = `DB_${'PASSWORD'}=hunter2SuperSecretLiveValue\n`;

interface ScanResult {
  readonly exitCode: number;
  readonly output: string;
}

/** A throwaway `gitroot/portal/...` checkout with the real script installed at `portal/scripts/`. */
function makeFixture(): { root: string; portal: string } {
  const root = mkdtempSync(join(tmpdir(), 't051-scan-gate-'));
  const portal = join(root, 'portal');
  mkdirSync(join(portal, 'scripts'), { recursive: true });
  mkdirSync(join(portal, 'back-end', 'src'), { recursive: true });
  mkdirSync(join(portal, 'back-end', 'test', 'security'), { recursive: true });

  const installed = join(portal, 'scripts', 'scan-secrets.sh');
  copyFileSync(SCRIPT, installed);
  chmodSync(installed, 0o755);

  // A repo with no commits — this project's own real state, and the condition under which
  // `git ls-files` returned nothing and F-14's second breakage went unnoticed.
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'nobody@example.invalid']);
  git(root, ['config', 'user.name', 'T-051 fixture']);
  return { root, portal };
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd, stdio: 'pipe' });
}

/** Runs the gate exactly as `npm run scan:secrets` does: `bash scripts/scan-secrets.sh`, cwd `portal/`. */
function runScan(portal: string): ScanResult {
  try {
    const output = execFileSync('bash', ['scripts/scan-secrets.sh'], {
      cwd: portal,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { exitCode: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('TC-23: the secret-scan gate fails on a secret and passes on a clean tree', () => {
  let fixture: { root: string; portal: string };

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('case 0 (control): a tree with no secret exits 0 and reports clean', () => {
    writeFileSync(join(fixture.portal, 'back-end/src/ordinary.ts'), 'export const x = 1;\n');

    const { exitCode, output } = runScan(fixture.portal);

    expect(exitCode).toBe(0);
    expect(output).toContain('scan:secrets: clean');
  });

  it('case 1: an UNSTAGED secret in src/ is caught, and the file is named', () => {
    // Untracked and unstaged — the state a working tree is in for almost all of its life, and the
    // state in which the pre-fix script scanned nothing at all.
    writeFileSync(join(fixture.portal, 'back-end/src/leak.ts'), SECRET_LINE);

    const { exitCode, output } = runScan(fixture.portal);

    expect(exitCode).not.toBe(0);
    expect(output).toContain('back-end/src/leak.ts');
    expect(output).not.toContain('scan:secrets: clean');
  });

  it('case 2: a STAGED secret is caught — the pre-commit path, one directory below the git root', () => {
    // F-14's third breakage lived exactly here: `git diff --cached --name-only` emits paths
    // relative to the *repository* root (`portal/back-end/...`) while the script's own cwd is
    // `portal/`, so every `[ -f "$f" ]` test failed and the loop skipped the whole index.
    writeFileSync(join(fixture.portal, 'back-end/src/staged-leak.ts'), SECRET_LINE);
    git(fixture.root, ['add', '-f', 'portal/back-end/src/staged-leak.ts']);

    const { exitCode, output } = runScan(fixture.portal);

    expect(exitCode).not.toBe(0);
    expect(output).toContain('back-end/src/staged-leak.ts');
  });

  it('case 3: the gate distinguishes a secret from ordinary code in the same tree', () => {
    // Both files present: the scan must fail, and must name the offender rather than its neighbour.
    // Without this, "exits non-zero" could be satisfied by a script that fails on any input.
    writeFileSync(join(fixture.portal, 'back-end/src/ordinary.ts'), 'export const x = 1;\n');
    writeFileSync(join(fixture.portal, 'back-end/src/leak.ts'), SECRET_LINE);

    const { exitCode, output } = runScan(fixture.portal);

    expect(exitCode).not.toBe(0);
    expect(output).toContain('back-end/src/leak.ts');
    expect(output).not.toContain('back-end/src/ordinary.ts');
  });

  it('case 4 (F-16, policy as built — NOT an endorsement): a secret under test/ is NOT caught', () => {
    // See this file's header. T-089 excludes the `test/` and `e2e/` trees; T-051's report records that
    // as F-16 (Low) with the case for narrowing it. If this test fails because the exclusion was
    // narrowed, that is the intended remedy landing — read F-16 in
    // `project-plan/reports/T-051-security-review.md`, then delete this case.
    writeFileSync(join(fixture.portal, 'back-end/test/security/fixture-leak.ts'), SECRET_LINE);

    const { exitCode, output } = runScan(fixture.portal);

    expect(exitCode).toBe(0);
    expect(output).toContain('scan:secrets: clean');
  });
});
