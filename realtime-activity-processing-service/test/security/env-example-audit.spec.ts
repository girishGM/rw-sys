/**
 * T-RAP-042 — TC-6. `.env.example` audit (task Implementation note 2): every value present is a
 * clearly-fake placeholder, never a real-looking default secret.
 *
 * **Completeness gap found and filed, not silently fixed here.** A full grep of every
 * `process.env.*` read in `src/` turned up several required var names
 * (`FIELD_ENCRYPTION_AES_KEY`, `FIELD_ENCRYPTION_HMAC_KEY`, `PROGRESS_API_AUTH_SECRET`,
 * `GRPC_SERVER_*`, `PORTAL_GRPC_*`, `REWARD_REDEMPTION_GRPC_*`, `PORTAL_CONFIG_TENANT_IDS`,
 * `DEMO_PORTAL_TENANT_ID`, `PROGRESS_API_PORT`) that `.env.example` does not document at all —
 * this task's own Scope/§7.1 ("file a defect for any gap found rather than silently fixing it if
 * the fix would touch a file outside this task's own scope") applies directly: `.env.example` is
 * `agent-rap-foundation`'s file (`project.config.json`), not this task's. See this task's own
 * completion report for the filed defect id. This test asserts the one property that actually is
 * this file's job to gate (no real-looking secret value, TC-6's own stated expected result) — it
 * deliberately does not assert completeness itself, since a hard-failing test for a gap this task
 * cannot fix would violate `AGENT-PROTOCOL.md` R11 ("do not mark a task done with a failing
 * check") for a check this task has no ability to make pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV_EXAMPLE_PATH = join(__dirname, '..', '..', '.env.example');

/** Every `KEY=value` line (ignores comments/blank lines). */
function parseEnvExample(): { key: string; value: string }[] {
  const content = readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const eq = line.indexOf('=');
      return { key: line.slice(0, eq), value: line.slice(eq + 1) };
    });
}

// Same literal-shape heuristic `scripts/scan-secrets.sh` itself uses: a run of 8+ unbroken
// non-space characters is what makes a value "shaped like a real secret" rather than a
// placeholder/empty value.
const REAL_LOOKING_SECRET = /^[^\s]{8,}$/;
const SENSITIVE_KEY = /(PASSWORD|SECRET|PRIVATE[_ ]?KEY)/i;

describe('T-RAP-042 TC-6 — .env.example has no real-looking default secret', () => {
  it('every PASSWORD/SECRET/PRIVATE_KEY-shaped key is empty or an obvious placeholder', () => {
    const entries = parseEnvExample();
    const sensitiveEntries = entries.filter((e) => SENSITIVE_KEY.test(e.key));
    expect(sensitiveEntries.length).toBeGreaterThan(0); // sanity: this file really has such keys

    const offenders = sensitiveEntries.filter((e) => REAL_LOOKING_SECRET.test(e.value));
    expect(offenders).toEqual([]);
  });

  it('has zero blank/whitespace-only lines masquerading as values for a sensitive key', () => {
    // Belt-and-braces: `DB_APP_PASSWORD= ` (trailing space, still "empty" in intent) should not
    // be mistaken for a filled-in value by the check above.
    const entries = parseEnvExample();
    for (const entry of entries.filter((e) => SENSITIVE_KEY.test(e.key))) {
      expect(entry.value.trim().length === 0 || !REAL_LOOKING_SECRET.test(entry.value.trim())).toBe(
        true,
      );
    }
  });
});
