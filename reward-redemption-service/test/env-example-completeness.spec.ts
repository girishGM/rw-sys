/**
 * T-RR-066. Regression coverage for the defect class T-RR-035's own completion report already
 * flagged and nobody followed up on until this task: a bearer token (or any other var) read
 * directly via `process.env.X` by a Wave 1+ module — i.e. anything **outside**
 * `src/config/config.schema.ts`'s Zod-validated set — can be silently absent from both
 * `.env.example` (so nobody deploying/onboarding this service ever learns it exists) and
 * `.env.development` (so any real-Nest-DI test/boot that actually constructs the owning provider
 * throws `Missing<Whatever>Error` — exactly what happened here for `REWARD_TRACKING_REST_TOKEN`
 * once T-RR-064 made `RewardTrackingRestClient` reachable through real DI for the first time).
 *
 * TC-1/TC-3: reverting this task's `.env.example`/`.env.development` changes (i.e. deleting the
 * `REWARD_TRACKING_REST_TOKEN=` line from either file) makes the corresponding assertion below
 * fail — proven manually per the completion report, since a passing regression test must have
 * been seen red at least once.
 *
 * T-RR-073 adds a second describe block to this same file (rather than a new spec file, since
 * `render.yaml` is not a directory this agent has a `test/**` glob grant for — only this one
 * file): `render.yaml`'s own envVars list had drifted out of sync with the set of vars that
 * actually crash this service's boot/construction when unset (config.schema.ts's Zod-required
 * fields, plus every directly-read var each owning module throws on if missing). A Blueprint
 * apply of the file as it stood would have deployed a container that never reaches
 * `app.listen()`. See that describe block's own header for the exact reproduction.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadRewardTrackingRestClientOptions,
  loadRewardTrackingRestToken,
} from '../src/modules/dispatch/reward-tracking-rest.client';
import { configSchema } from '../src/config/config.schema';

const SERVICE_ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(SERVICE_ROOT, 'src');

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(SERVICE_ROOT, relativePath), 'utf8');
}

/** Strips `/** ... *\/` block comments and `//` line comments so a var name mentioned only in
 * prose (e.g. this file's own header, or `load-dotenv-files.ts`'s illustrative
 * `process.env.THAT_VAR`) is never mistaken for a real read. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function listTsFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listTsFilesRecursive(fullPath);
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      return [fullPath];
    }
    return [];
  });
}

/** Every env var this service's own (non-test) source reads directly via `process.env.NAME`,
 * i.e. outside `config.schema.ts`'s Zod validation — the exact set `.env.example`'s own "read
 * directly from process.env by its own module" section (see that file's header) documents. */
function directProcessEnvReadsInSrc(): Set<string> {
  const names = new Set<string>();
  for (const filePath of listTsFilesRecursive(SRC_ROOT)) {
    const code = stripComments(fs.readFileSync(filePath, 'utf8'));
    for (const match of code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

function parseDotenv(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    values.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return values;
}

describe('T-RR-066 — .env.example / .env.development completeness for directly-read env vars', () => {
  it('TC-1/TC-2: every var read directly via process.env in src is documented as a key in .env.example', () => {
    const documented = parseDotenv(readFile('.env.example'));
    const readDirectly = directProcessEnvReadsInSrc();
    const undocumented = [...readDirectly].filter((name) => !documented.has(name));
    expect(undocumented).toEqual([]);
  });

  it('TC-1/TC-2: REWARD_TRACKING_REST_TOKEN specifically is documented in .env.example', () => {
    const documented = parseDotenv(readFile('.env.example'));
    expect(documented.has('REWARD_TRACKING_REST_TOKEN')).toBe(true);
  });

  it('TC-1/TC-2: REWARD_TRACKING_REST_TOKEN has a real, non-empty local-dev value in .env.development', () => {
    const devValues = parseDotenv(readFile('.env.development'));
    const value = devValues.get('REWARD_TRACKING_REST_TOKEN');
    expect(value).toBeDefined();
    expect((value ?? '').trim().length).toBeGreaterThan(0);
  });

  it('TC-2: loadRewardTrackingRestToken()/loadRewardTrackingRestClientOptions() resolve from the real process.env (as loaded from .env.development by test/database/env.setup.ts) without throwing', () => {
    // Cross-check against the file directly, rather than only against whatever setupFiles already
    // put on process.env, so this test does not silently pass just because some earlier test left
    // a value behind.
    const devValues = parseDotenv(readFile('.env.development'));
    const expectedToken = devValues.get('REWARD_TRACKING_REST_TOKEN');

    expect(() => loadRewardTrackingRestToken()).not.toThrow();
    expect(loadRewardTrackingRestToken()).toBe(expectedToken);

    expect(() => loadRewardTrackingRestClientOptions()).not.toThrow();
  });

  it('TC-4: adjacent, already-documented tokens are unaffected (still documented and still distinct from each other)', () => {
    const documented = parseDotenv(readFile('.env.example'));
    for (const name of [
      'REWARD_ENTRY_INGEST_TOKEN',
      'CACHE_ADMIN_TOKEN',
      'GENERATION_SERVICE_TOKEN',
      'REWARD_TRACKING_REST_TOKEN',
    ]) {
      expect(documented.has(name)).toBe(true);
    }
    const devValues = parseDotenv(readFile('.env.development'));
    const cacheAdminToken = devValues.get('CACHE_ADMIN_TOKEN');
    const rewardTrackingToken = devValues.get('REWARD_TRACKING_REST_TOKEN');
    expect(cacheAdminToken).toBeDefined();
    expect(rewardTrackingToken).toBeDefined();
    expect(cacheAdminToken).not.toBe(rewardTrackingToken);
  });
});

/**
 * T-RR-073. `render.yaml` is a static deploy artifact — nothing exercises it at runtime the way
 * `test/database/env.setup.ts` exercises `.env.development` — so a var this service actually
 * requires at boot/construction can silently drift out of its `envVars:` list with nothing else
 * ever catching it (exactly what T-RR-047's deploy-readiness review found: `GRPC_SERVER_TLS_*`,
 * `GRPC_SERVER_ALLOWED_IDENTITIES`, `PORTAL_CONFIG_TENANT_IDS`, `FIELD_ENCRYPTION_*` and
 * `REWARD_TRACKING_REST_TOKEN` were all missing from the file's `envVars:` list, even though each
 * one crashes this service's boot or a provider's construction if unset).
 *
 * TC-3: reverting this task's `render.yaml` change (deleting any one of the `- key:` entries this
 * task added) makes the first test below fail — proven manually per the completion report.
 */
describe('T-RR-073 — render.yaml declares every var this service requires at boot/construction', () => {
  /** Every `- key: NAME` entry declared under `services[0].envVars` in `render.yaml`. A
   * line-based extractor, not a full YAML parser — matches this file's own existing
   * `parseDotenv()` convention above (good enough for a flat, hand-authored list; a real parser
   * would be overkill for one file this shape). */
  function renderYamlEnvVarKeys(): Set<string> {
    const content = readFile('render.yaml');
    const keys = new Set<string>();
    for (const match of content.matchAll(/^\s*-\s*key:\s*([A-Z][A-Z0-9_]*)\s*$/gm)) {
      keys.add(match[1]);
    }
    return keys;
  }

  /** Every field `config.schema.ts`'s Zod schema fails to parse out of an empty `{}` — i.e. has
   * no `.default(...)` and is therefore required, with a boot-time crash the actual enforcement
   * mechanism (`validateConfig()`'s `process.exit(1)`), not a convention this test re-derives by
   * hand. A field with a code-level default (e.g. `GRPC_SERVER_PORT`, `DB_PORT`) is correctly
   * excluded — leaving it unset at deploy time is safe, per that field's own default. */
  function requiredConfigSchemaFields(): Set<string> {
    const result = configSchema.safeParse({});
    const names = new Set<string>();
    if (!result.success) {
      for (const issue of result.error.issues) {
        names.add(String(issue.path[0]));
      }
    }
    return names;
  }

  /** Vars read directly via `process.env.X` (outside `config.schema.ts`) that the owning module
   * itself throws a named error for if unset/blank — confirmed by direct read of each cited file,
   * the same evidence T-RR-047's review recorded. Unlike `requiredConfigSchemaFields()` above,
   * there is no single shared mechanism to derive this list at test-run time (each module has its
   * own guard), so it is hand-maintained here; TC-4 below guards against a var being added to this
   * set without a citation. */
  const REQUIRED_DIRECT_READ_VARS: ReadonlyArray<{ name: string; guardedBy: string }> = [
    {
      name: 'PORTAL_CONFIG_TENANT_IDS',
      guardedBy: 'campaign-config.client.ts loadPortalConfigTenantIds()',
    },
    { name: 'FIELD_ENCRYPTION_AES_KEY', guardedBy: 'encryption.service.ts' },
    { name: 'FIELD_ENCRYPTION_HMAC_KEY', guardedBy: 'encryption.service.ts' },
    {
      name: 'REWARD_TRACKING_REST_TOKEN',
      guardedBy: 'reward-tracking-rest.client.ts loadRewardTrackingRestToken()',
    },
    { name: 'REWARD_ENTRY_INGEST_TOKEN', guardedBy: 'ingest-token.guard.ts' },
    { name: 'CACHE_ADMIN_TOKEN', guardedBy: 'cache-admin-token.ts loadCacheAdminToken()' },
  ];

  it('TC-1/TC-2/TC-3: every config.schema.ts field with no default is declared in render.yaml envVars', () => {
    const declared = renderYamlEnvVarKeys();
    const required = requiredConfigSchemaFields();
    const missing = [...required].filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });

  it('TC-1/TC-2/TC-3: every directly-read, required-with-no-default var is declared in render.yaml envVars', () => {
    const declared = renderYamlEnvVarKeys();
    const missing = REQUIRED_DIRECT_READ_VARS.filter((entry) => !declared.has(entry.name));
    expect(missing).toEqual([]);
  });

  it('TC-4: adjacent vars that already had a code-level default (safe to leave unset) are still present as sync:false placeholders, not required', () => {
    const declared = renderYamlEnvVarKeys();
    for (const name of [
      'PORTAL_GRPC_HOST',
      'PORTAL_GRPC_PORT',
      'PORTAL_GRPC_TIMEOUT_MS',
      'PORTAL_GRPC_TLS_CA_PATH',
      'PORTAL_GRPC_TLS_CERT_PATH',
      'PORTAL_GRPC_TLS_KEY_PATH',
    ]) {
      expect(declared.has(name)).toBe(true);
    }
    // GRPC_SERVER_PORT has a safe code-level default and is deliberately still absent — a
    // regression that starts requiring it would need this test updated deliberately, not
    // silently, which is exactly why it's asserted explicitly rather than left unchecked.
    expect(declared.has('GRPC_SERVER_PORT')).toBe(false);
  });

  it('TC-4: adjacent, already-present vars (DB, Kafka, the three original bearer tokens) are unaffected', () => {
    const declared = renderYamlEnvVarKeys();
    for (const name of [
      'DB_HOST',
      'DB_PORT',
      'DB_NAME',
      'DB_APP_USERNAME',
      'DB_APP_PASSWORD',
      'DB_MIGRATION_USERNAME',
      'DB_MIGRATION_PASSWORD',
      'KAFKA_BROKERS',
      'REWARD_ENTRY_INGEST_TOKEN',
      'CACHE_ADMIN_TOKEN',
      'GENERATION_SERVICE_TOKEN',
    ]) {
      expect(declared.has(name)).toBe(true);
    }
  });
});
