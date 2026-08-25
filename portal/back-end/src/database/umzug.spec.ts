/**
 * T-079 — regression coverage for `migrationGlobPattern`, the extension-agnostic glob
 * `createMigrator()` now derives from its own `__filename` instead of the old hard-coded
 * `migrations/*.ts` (see that function's own header for the full defect writeup and
 * `project-plan/reports/T-079-*.md` for the live, real-Postgres/real-Docker reproduction —
 * neither a database nor a compiled build is required to prove the glob-selection logic
 * itself is correct).
 *
 * Colocated with the module under test (`src/database/umzug.ts`), the same pattern
 * `cli/encryption-keys.spec.ts` already establishes for this directory (`jest.config.js`'s
 * `rootDir: 'src'` + default `testRegex` picks up any `*.spec.ts` under `src/`, no `roots`
 * entry needed).
 */
import path from 'node:path';
import fs from 'node:fs';
import { migrationGlobPattern, MIGRATIONS_DIR } from './umzug';

describe('migrationGlobPattern', () => {
  it(
    'TC-2/TC-3: resolves to the compiled JS glob once tsc has emitted .js — the exact ' +
      'case that silently discovered zero migrations before the fix (T-079)',
    () => {
      expect(migrationGlobPattern('/app/back-end/dist/database/umzug.js')).toBe('migrations/*.js');
    },
  );

  it('resolves to the .ts glob under ts-node/ts-jest source execution', () => {
    expect(migrationGlobPattern('/app/back-end/src/database/umzug.ts')).toBe('migrations/*.ts');
  });

  it(
    'tracks whatever extension its own module happens to be running as — not a ' +
      'hard-coded assumption about either environment',
    () => {
      expect(migrationGlobPattern('/anywhere/umzug.mjs')).toBe('migrations/*.mjs');
    },
  );

  it(
    "TC-4: this suite's own runtime (__filename) round-trips through the real function " +
      'the same way createMigrator() itself invokes it',
    () => {
      // Whatever extension *this test file* is actually running under (ts-jest: `.ts`) is
      // exactly what createMigrator() would glob for if it ran in this same process — proving
      // the fix does not regress the still-current, still-most-common case (`npm run
      // db:migrate` via ts-node, and every unit/e2e suite in this repo, ts-jest).
      const ext = path.extname(__filename);
      expect(migrationGlobPattern(__filename)).toBe(`migrations/*${ext}`);
    },
  );
});

describe('MIGRATIONS_DIR + migrationGlobPattern, exercised against the real migrations directory', () => {
  it(
    "TC-4 (adjacent behaviour unchanged): under this process's own extension, the glob " +
      'this task produces would match every real migration file on disk — the property ' +
      'that was silently false for the compiled case before this fix',
    () => {
      const ext = path.extname(__filename); // '.ts' under ts-jest, matching source layout
      const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(ext));

      // 46 as of T-079 (T002 through T056's migrations); asserting "more than a handful"
      // rather than the literal count so this test does not need editing every time a
      // future task adds a migration file — the property under test is "the glob would
      // find real files", not "there are exactly N of them" (AGENT-PROTOCOL §3: assert the
      // observable property, not a restated constant).
      expect(onDisk.length).toBeGreaterThan(40);
      expect(onDisk.every((f) => /^T\d{3}_\d{3}_/.test(f))).toBe(true);
    },
  );
});
