/**
 * T-RAP-057 — TC-3 regression test. `.env.example` must name every environment variable this
 * service actually reads, not just the `src/config/config.schema.ts`-validated subset.
 *
 * `test/security/env-example-audit.spec.ts` (T-RAP-042, `agent-rap-qa`'s file) only asserts that
 * no *documented* value looks like a real secret — it has no completeness assertion, which is
 * exactly the gap this task exists to close (see this task's own review note: reverting
 * `.env.example` to its pre-T-RAP-057 state left that spec still green). This file is the missing
 * completeness check, kept separate rather than added to that spec because `test/security/**` is
 * outside `agent-rap-foundation`'s file scope (`project.config.json`) — a single-file grant for
 * *this* path was added instead, following the same precedent `.env.example` itself already used.
 *
 * Two independent sources of "required env var names" are combined and diffed against
 * `.env.example`'s own documented keys:
 *
 *   1. `src/config/config.schema.ts`'s `configSchema` object keys — the validated set every
 *      later task is supposed to extend rather than bypass.
 *   2. Every other place in `src/` that reads `process.env` directly (each such call site
 *      documents, in its own header, why it bypasses `config.schema.ts` — see e.g.
 *      `encryption.service.ts`). Three shapes appear in this codebase and are all detected:
 *        - literal dot access:    `process.env.FIELD_ENCRYPTION_AES_KEY`
 *        - literal bracket access: `process.env['GRPC_SERVER_ALLOWED_IDENTITIES']`
 *        - indirect bracket access through an exported string-literal const, e.g.
 *          `messaging/ingest/ingest.config.ts`'s `ACTIVITY_INGEST_CONSUMER_ENABLED_ENV_VAR`, or
 *          through a helper function's string-literal argument, e.g.
 *          `grpc-server.config.ts`'s `readRequiredFile('GRPC_SERVER_TLS_CA_PATH')`.
 *
 * This is a fixed, known codebase, not a general-purpose static analyzer — the extraction below
 * is deliberately scoped to the three shapes actually in use today. If a future task introduces a
 * genuinely new indirection shape, this test's own extraction needs a matching update, the same
 * way `config.schema.ts`'s own header asks every new required var to extend it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SERVICE_ROOT = join(__dirname, '..');
const SRC_ROOT = join(SERVICE_ROOT, 'src');
const ENV_EXAMPLE_PATH = join(SERVICE_ROOT, '.env.example');
const CONFIG_SCHEMA_PATH = join(SRC_ROOT, 'config', 'config.schema.ts');

/** Every documented `KEY=value` line in `.env.example` (ignores comments/blank lines). */
function documentedEnvVarNames(): Set<string> {
  const content = readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const names = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    names.add(line.slice(0, eq).trim());
  }
  return names;
}

/** Every `.ts` file under `src/`, excluding unit-test specs. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** `configSchema`'s own top-level zod object keys — the config.schema.ts-validated set. */
function configSchemaKeys(): Set<string> {
  const content = readFileSync(CONFIG_SCHEMA_PATH, 'utf8');
  const objectMatch = content.match(/z\.object\(\{([\s\S]*?)\n\}\)/);
  if (!objectMatch) {
    throw new Error(
      "Could not locate `z.object({ ... })` in config.schema.ts — this test's own extraction " +
        'needs updating to match a structural change there.',
    );
  }
  const keys = new Set<string>();
  const keyRegex = /^\s*([A-Z][A-Z0-9_]*):/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRegex.exec(objectMatch[1]))) {
    keys.add(m[1]);
  }
  return keys;
}

/**
 * Every env var name read directly via `process.env` anywhere under `src/`, resolving the two
 * indirection shapes this codebase actually uses (exported string-literal const, and a
 * string-literal argument passed to a helper whose parameter is used as `process.env[param]`).
 */
function directlyReadEnvVarNames(): Set<string> {
  const files = listSourceFiles(SRC_ROOT);
  const fileContents = new Map<string, string>();
  for (const file of files) {
    fileContents.set(file, readFileSync(file, 'utf8'));
  }

  const names = new Set<string>();

  // Every `const IDENT = 'VALUE'` (with or without `export`) across the whole tree, so an
  // indirect `process.env[IDENT]` read in one file can resolve a const declared in another.
  const constLiterals = new Map<string, string>();
  for (const content of fileContents.values()) {
    const constRegex =
      /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]([A-Z][A-Z0-9_]*)['"]/g;
    let cm: RegExpExecArray | null;
    while ((cm = constRegex.exec(content))) {
      constLiterals.set(cm[1], cm[2]);
    }
  }

  // Helper functions whose own body reads `process.env[<their own param>]` — e.g.
  // `readRequiredFile(envVar: string) { ... process.env[envVar] ... }`. Once found, every
  // string-literal call-site argument anywhere in the tree is a real env var name.
  const indirectionFunctionNames: string[] = [];
  for (const content of fileContents.values()) {
    const fnRegex =
      /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*string\s*\)[^{]*\{([\s\S]*?)\n\}/g;
    let fm: RegExpExecArray | null;
    while ((fm = fnRegex.exec(content))) {
      const [, fnName, paramName, body] = fm;
      if (new RegExp(`process\\.env\\[\\s*${paramName}\\s*\\]`).test(body)) {
        indirectionFunctionNames.push(fnName);
      }
    }
  }

  for (const content of fileContents.values()) {
    // process.env.NAME (optionally chained: process.env.NAME?.trim())
    for (const m of content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
      names.add(m[1]);
    }
    // process.env['NAME'] / process.env["NAME"]
    for (const m of content.matchAll(/process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g)) {
      names.add(m[1]);
    }
    // process.env[identifier] where `identifier` is a known string-literal const
    for (const m of content.matchAll(/process\.env\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]/g)) {
      const literal = constLiterals.get(m[1]);
      if (literal) names.add(literal);
    }
    // fnName('LITERAL') where fnName is a known env-lookup-by-parameter helper
    for (const fnName of indirectionFunctionNames) {
      for (const m of content.matchAll(
        new RegExp(`${fnName}\\(\\s*['"]([A-Z_][A-Z0-9_]*)['"]`, 'g'),
      )) {
        names.add(m[1]);
      }
    }
  }

  return names;
}

describe('T-RAP-057 TC-3 — .env.example documents every env var this service reads', () => {
  it('has no undocumented process.env read (direct reads, all 3 known shapes)', () => {
    const documented = documentedEnvVarNames();
    const directReads = directlyReadEnvVarNames();

    // Sanity: this extraction must actually find something, or the whole test is a false green.
    expect(directReads.size).toBeGreaterThan(10);

    const missing = [...directReads].filter((name) => !documented.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('has no undocumented config.schema.ts-validated key', () => {
    const documented = documentedEnvVarNames();
    const schemaKeys = configSchemaKeys();

    expect(schemaKeys.size).toBeGreaterThan(5);

    const missing = [...schemaKeys].filter((name) => !documented.has(name)).sort();
    expect(missing).toEqual([]);
  });
});
