/**
 * T-RR-042 — R5 schema-isolation audit (`AGENT-PROTOCOL.md` R5,
 * `reward-redemption-service-plan/tasks/T-RR-042-security-review.md` implementation note 1).
 *
 * An independent, static audit of every source file under `src/` for any reference to another
 * service's own Postgres schema (`reward_config`, `reward_portal`, `realtime_activity_processing`,
 * `promo_code`) — this service's own tables live exclusively in `reward_redemption`
 * (`01-DATABASE.md` §1, migration `001_create_schema.ts`), and R5 requires this service never
 * reads or writes another schema directly. A match is only a genuine finding if it is not a
 * comment documenting the boundary itself (this file's own header, and several migration headers,
 * cite `reward_config.*` table names in prose to explain what this service's own table was
 * *modeled on* — that is not a live cross-schema reference).
 *
 * This is a real filesystem/content audit (not a mock of one) — it reads every `.ts` file under
 * `src/` at test-run time, so it can never go stale relative to what's actually on disk, and it
 * would genuinely fail if a future task ever introduced a live cross-schema reference (the
 * "assert the observable property" bar `AGENT-PROTOCOL.md` §3 sets — this test inspects the real
 * source tree, not a restated string).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');

const FOREIGN_SCHEMAS = [
  'reward_config',
  'reward_portal',
  'realtime_activity_processing',
  'promo_code',
] as const;

/** This service's own schema — every migration must create tables in this schema only. */
const OWN_SCHEMA = 'reward_redemption';

/** Plain recursive directory walk — no external `glob` dependency (this repo's own
 * `package.json` doesn't declare one; `node_modules/glob` exists only transitively, as another
 * package's own dependency, and pinning to it directly would be an undeclared, silently-removable
 * dependency). `fs.globSync` isn't usable either — it doesn't exist until Node 22, and this
 * project's own toolchain runs Node 20 (root `CLAUDE.md`). */
function listFilesRecursive(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      out.push(full);
    }
  }
  return out;
}

function listSourceFiles(): string[] {
  return listFilesRecursive(SRC_ROOT, '.ts');
}

/** A line is a genuine finding unless it is a line comment or a block-comment line, or falls
 * inside a block comment — approximated the same conservative way every other static-audit test
 * in this repo does: a comment line either starts with a `*` or `//` (after trimming leading
 * whitespace) or the match sits inside a block-comment span, tracked line-by-line below. */
function findLiveReferences(source: string, needle: string): string[] {
  const lines = source.split('\n');
  const findings: string[] = [];
  let inBlockComment = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (inBlockComment) {
      if (line.includes('*/')) {
        inBlockComment = false;
      }
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) {
        inBlockComment = true;
      }
      continue;
    }
    if (line.startsWith('*') || line.startsWith('//')) {
      continue;
    }
    if (line.includes(needle)) {
      findings.push(rawLine);
    }
  }
  return findings;
}

describe('T-RR-042 TC-1 — R5 schema-isolation audit', () => {
  const files = listSourceFiles();

  it('sanity: the audit actually walked a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const schema of FOREIGN_SCHEMAS) {
    it(`no live (non-comment) reference to "${schema}." exists anywhere under src/`, () => {
      const findings: Record<string, string[]> = {};
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        const hits = findLiveReferences(source, `${schema}.`);
        if (hits.length > 0) {
          findings[path.relative(SRC_ROOT, file)] = hits;
        }
      }
      expect(findings).toEqual({});
    });
  }

  it('every CREATE TABLE / CREATE SCHEMA in the migrations directory targets reward_redemption only', () => {
    const migrationsDir = path.join(SRC_ROOT, 'database', 'migrations');
    const files = listFilesRecursive(migrationsDir, '.ts');
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const createTableMatches = source.match(/CREATE TABLE\s+([a-zA-Z0-9_.]+)/g) ?? [];
      const createSchemaMatches = source.match(/CREATE SCHEMA[^;]*?([a-zA-Z0-9_]+);/g) ?? [];
      for (const m of createTableMatches) {
        if (!m.includes(`${OWN_SCHEMA}.`)) {
          offenders.push(`${path.basename(file)}: ${m}`);
        }
      }
      for (const m of createSchemaMatches) {
        if (!m.includes(OWN_SCHEMA)) {
          offenders.push(`${path.basename(file)}: ${m}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no Sequelize/ORM decorator declares a model or association at all (this repo uses plain row interfaces + raw SQL, not @Table/@ForeignKey/@BelongsTo, per every models/*.ts file header) — a cross-schema association can only exist through one of these decorators', () => {
    const modelsDir = path.join(SRC_ROOT, 'database', 'models');
    const files = listFilesRecursive(modelsDir, '.ts');
    const decoratorPattern = /@(Table|ForeignKey|BelongsTo|HasMany|HasOne|BelongsToMany)\(/;
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (decoratorPattern.test(source)) {
        offenders.push(path.basename(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the rr_app role migration grants only ON SCHEMA reward_redemption / ON ALL TABLES IN SCHEMA reward_redemption — never a bare GRANT ... ON DATABASE or a grant naming another schema', () => {
    const roleMigration = path.join(
      SRC_ROOT,
      'database',
      'migrations',
      '014_create_rr_app_role.ts',
    );
    const source = readFileSync(roleMigration, 'utf8');
    // Strip block comments (`/* ... */`, including this file's own `/** ... */` doc comments)
    // before scanning for real `GRANT ...;` SQL statements — otherwise a `GRANT` mentioned only
    // in prose (this migration's own header discusses "GRANT ALL ON DATABASE" as the thing it
    // deliberately does NOT do) would be misread as a live statement.
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const grantLines = withoutComments.match(/GRANT[^;]*;/g) ?? [];
    expect(grantLines.length).toBeGreaterThan(0);
    for (const line of grantLines) {
      expect(line).not.toMatch(/GRANT\s+ALL\s+ON\s+DATABASE/i);
      for (const schema of FOREIGN_SCHEMAS) {
        expect(line).not.toContain(schema);
      }
    }
  });
});
