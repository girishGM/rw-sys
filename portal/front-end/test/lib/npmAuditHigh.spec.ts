/**
 * T-081 TC-1..TC-3 — 02-SECURITY.md §11's release checklist and T-051 TC-21 both require
 * `npm audit --audit-level=high` to be clean ("zero high/critical").
 *
 * Per AGENT-PROTOCOL.md §3 ("assert the observable property, not the implementation
 * string"), this deliberately shells out to the *real* `npm audit` — the actual client
 * that judges the property, backed by the live npm advisory registry — rather than
 * asserting a pinned version string in `package.json`. A test that only checked
 * `package.json` for `"vite": "6.4.3"` would be a change-detector: it would stay green
 * forever even if a *new* advisory were later published against 6.4.3 itself, and it
 * would not have caught the original defect (`vite@5.4.21`, high severity, GHSA-fx2h-
 * pf6j-xcff) any more precisely than reading the file by eye. Running the real command is
 * what actually would have failed red before this task's fix (reproduced by hand: `npm
 * audit --json` reported `{high: 1}` with `vite@5.4.21`) and passes now.
 *
 * Network-dependent (hits the live `registry.npmjs.org` advisory database, same as the
 * release checklist itself) and workspace-root-scoped (`npm audit` is not meaningful
 * per-workspace — devDependencies live at the hoisted root `node_modules`), unlike every
 * other spec in this directory. Both are intentional: this is the same command the release
 * checklist runs, run the same way.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
// front-end/test/lib -> portal/ (the npm workspace root `npm audit` must run from).
const PORTAL_ROOT = join(__dirname, '..', '..', '..');

interface NpmAuditReport {
  metadata: {
    vulnerabilities: {
      critical: number;
      high: number;
      moderate: number;
      low: number;
      info: number;
    };
  };
}

function runNpmAudit(): NpmAuditReport {
  // `npm audit` exits non-zero whenever it finds anything reportable, which is the normal,
  // expected outcome while moderate-severity findings remain outstanding (see T-081's
  // completion report) — so the JSON body, not the exit code, is what this test judges.
  let raw: string;
  try {
    raw = execFileSync('npm', ['audit', '--json'], {
      cwd: PORTAL_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
  } catch (err) {
    // execFileSync throws on non-zero exit, but `npm audit --json` still writes the report
    // to stdout in that case — recover it rather than treating "found vulnerabilities" as a
    // harness failure.
    const stdout = (err as { stdout?: string | Buffer }).stdout;
    if (!stdout) throw err;
    raw = stdout.toString();
  }
  return JSON.parse(raw) as NpmAuditReport;
}

describe('npm audit --audit-level=high release gate (02-SECURITY.md §11, T-051 TC-21)', () => {
  it('reports zero high and zero critical severity advisories workspace-wide', () => {
    const report = runNpmAudit();
    const { high, critical } = report.metadata.vulnerabilities;

    expect({ high, critical }).toEqual({ high: 0, critical: 0 });
  }, 60_000);

  it('`npm audit --audit-level=high` itself exits clean, matching the release checklist exactly', () => {
    // The checklist runs this exact invocation, not the --json form above; prove the
    // literal gate command passes too, since --audit-level filtering is npm's own logic,
    // not something this test re-implements.
    expect(() =>
      execFileSync('npm', ['audit', '--audit-level=high'], {
        cwd: PORTAL_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
      }),
    ).not.toThrow();
  }, 60_000);
});
