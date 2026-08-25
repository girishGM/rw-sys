/**
 * T-013 TC-20 — *"Add `Campaign.findAll()` directly in a service file, run lint → Lint error
 * from the ban rule."*
 *
 * Verification step 3 of the task file asks for this to be done by hand. Doing it by hand once
 * proves the rule worked once; running ESLint programmatically against in-memory source proves
 * it on every CI run, and — more importantly — proves the two properties a hand check almost
 * never covers:
 *
 *  1. the rule **does not** fire on the code it must not fire on. `createHash(...).update(...)`
 *     and `cipher.update(...)` in `src/common/crypto` are correct, security-critical code; a ban
 *     rule that flagged them would be answered with `eslint-disable` comments in the crypto core,
 *     which AGENT-PROTOCOL R2 forbids in the same breath as it demands the rule. The false
 *     positives matter as much as the true ones.
 *  2. the exemptions are exactly `src/common/scope/`, `src/database/` and `test/` — and nowhere
 *     else. A fourth exemption added quietly would show up here.
 *
 * The linter is invoked through the project's real `.eslintrc.cjs`, so this asserts the shipped
 * configuration rather than a copy of it.
 */
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const BACK_END_ROOT = resolve(__dirname, '../..');
const RULE = 'no-restricted-syntax';

/**
 * Lints `code` as if it lived at `filePath`, using the project configuration.
 *
 * `lintText` respects `overrides` in `.eslintrc.cjs`, which is what lets the exemption cases
 * below be meaningful. Type-aware rules are switched off for this pass — the file does not exist
 * on disk, so the TypeScript program cannot include it, and `no-restricted-syntax` is a purely
 * syntactic rule that needs no type information.
 */
async function lint(filePath: string, code: string): Promise<ESLint.LintResult[]> {
  // The installed `@types/eslint` is 9.x (flat config) while the installed `eslint` is 8.57
  // (eslintrc). `overrideConfig.parserOptions` is valid at runtime on 8.x and absent from the 9.x
  // `Options` type, so the shape is asserted rather than inferred. T-013: this is a
  // types-vs-runtime version skew in a dev dependency, not a behavioural cast — the object below
  // is exactly what ESLint 8 documents.
  const options = {
    cwd: BACK_END_ROOT,
    // `project: null` turns off the TypeScript program for this pass. `lintText` supplies a
    // virtual path that is not on disk, so a type-aware parser would refuse it — and
    // `no-restricted-syntax` is purely syntactic and needs no type information.
    overrideConfig: { parserOptions: { project: null } },
  } as unknown as ESLint.Options;

  const eslint = new ESLint(options);
  return eslint.lintText(code, { filePath: resolve(BACK_END_ROOT, filePath) });
}

async function banMessages(filePath: string, code: string): Promise<string[]> {
  const [result] = await lint(filePath, code);
  return result.messages.filter((message) => message.ruleId === RULE).map((m) => m.message);
}

describe('no-raw-model-access lint rule (TC-20)', () => {
  jest.setTimeout(60_000);

  describe('bans raw model access in a service file', () => {
    it.each([
      ['findAll', 'await Campaign.findAll({ where: { id: 1 } });'],
      ['findOne', 'await Campaign.findOne({ where: { id: 1 } });'],
      ['findByPk', 'await Campaign.findByPk(1);'],
      ['findAndCountAll', 'await Campaign.findAndCountAll({});'],
      ['findOrCreate', 'await Campaign.findOrCreate({ where: { id: 1 } });'],
      ['bulkCreate', 'await Campaign.bulkCreate([]);'],
      ['upsert', 'await Campaign.upsert({});'],
      ['create', 'await Campaign.create({});'],
      ['update', 'await Campaign.update({}, { where: { id: 1 } });'],
      ['destroy', 'await Campaign.destroy({ where: { id: 1 } });'],
      ['count', 'await Campaign.count({});'],
      ['increment', 'await Campaign.increment("x", { where: { id: 1 } });'],
      ['truncate', 'await Campaign.truncate();'],
    ])('%s', async (_name, statement) => {
      const messages = await banMessages(
        'src/modules/campaigns/campaign.service.ts',
        `export async function run(Campaign: any) { ${statement} }`,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('ScopedRepository');
      expect(messages[0]).toContain('Do not disable this rule');
    });

    it('catches the finder methods on a non-class receiver too', async () => {
      // `this.model.findAll()` — the shape somebody reaches for when a lint rule appears to only
      // look at capitalised identifiers.
      const messages = await banMessages(
        'src/modules/campaigns/campaign.service.ts',
        'export async function run(repo: any) { await repo.findAll({}); }',
      );

      expect(messages).toHaveLength(1);
    });

    it('catches it in a guard, an interceptor or any other src file', async () => {
      for (const path of [
        'src/common/rbac/roles.guard.ts',
        'src/common/audit/audit.interceptor.ts',
        'src/modules/me/me.service.ts',
      ]) {
        const messages = await banMessages(
          path,
          'export async function run(Campaign: any) { await Campaign.findAll({}); }',
        );
        expect(messages).toHaveLength(1);
      }
    });
  });

  describe('does not fire on code that is not Sequelize', () => {
    it.each([
      ['createHash(...).update()', 'createHash("sha256").update(value, "utf8").digest("hex");'],
      ['createHmac(...).update()', 'createHmac("sha256", key).update(value).digest("hex");'],
      ['cipher.update()', 'const out = cipher.update(plaintext, "utf8");'],
      ['decipher.update()', 'const out = decipher.update(buffer);'],
      ['Math.max', 'const n = Math.max(1, 2);'],
      ['Math.min', 'const n = Math.min(1, 2);'],
      ['Object.create', 'const o = Object.create(null);'],
      ['Promise.all', 'await Promise.all([]);'],
      ['Map.set / Set.add', 'const m = new Map(); m.set(1, 2);'],
      ['NestFactory.create', 'const app = await NestFactory.create(AppModule);'],
      ['a service method that happens to be called create', 'await this.sessions.create(input);'],
      ['a service method called update', 'await this.store.update(id, values);'],
      ['a local helper named createSomething', 'await createSession(input);'],
    ])('%s', async (_name, statement) => {
      const messages = await banMessages(
        'src/common/crypto/field-crypto.service.ts',
        `/* eslint-disable @typescript-eslint/no-unused-vars */
         export async function run(
           createHash: any, createHmac: any, cipher: any, decipher: any, value: any, key: any,
           plaintext: any, buffer: any, NestFactory: any, AppModule: any, id: any, values: any,
           input: any, createSession: any, self: any,
         ) { const this_: any = self; void this_; ${statement.replace(/this\./g, 'this_.')} }`,
      );

      expect(messages).toEqual([]);
    });

    it('leaves the real crypto core clean', async () => {
      // The regression that motivated a precise selector rather than the task file's sketch:
      // the illustrative version flags `cipher.update()` throughout `src/common/crypto`.
      const eslint = new ESLint({ cwd: BACK_END_ROOT });
      const results = await eslint.lintFiles(['src/common/crypto/**/*.ts']);
      const offenders = results.flatMap((result) =>
        result.messages.filter((message) => message.ruleId === RULE),
      );

      expect(offenders).toEqual([]);
    });
  });

  describe('exemptions — exactly three, and no more', () => {
    const rawAccess = 'export async function run(Campaign: any) { await Campaign.findAll({}); }';

    it('src/common/scope/ is exempt — it is the implementation of the rule', async () => {
      await expect(
        banMessages('src/common/scope/scoped.repository.ts', rawAccess),
      ).resolves.toEqual([]);
    });

    it('src/database/ is exempt — models, migrations and the connection itself', async () => {
      await expect(banMessages('src/database/models/thing.model.ts', rawAccess)).resolves.toEqual(
        [],
      );
      await expect(
        banMessages('src/database/migrations/T999_001_thing.ts', rawAccess),
      ).resolves.toEqual([]);
    });

    it('test/ is exempt — a test must build and verify its own fixtures', async () => {
      await expect(banMessages('test/database/models.e2e-spec.ts', rawAccess)).resolves.toEqual([]);
    });

    it('a sibling of an exempt directory is NOT exempt', async () => {
      // `src/common/scoped/` and `src/databases/` must not inherit the exemption by prefix.
      await expect(banMessages('src/common/scoping/helper.ts', rawAccess)).resolves.toHaveLength(1);
      await expect(banMessages('src/databases/helper.ts', rawAccess)).resolves.toHaveLength(1);
    });

    it('src/common/rbac/ is NOT exempt — the guards go through ScopedRepository like everything else', async () => {
      await expect(
        banMessages('src/common/rbac/permission.repository.ts', rawAccess),
      ).resolves.toHaveLength(1);
    });
  });

  describe('the whole shipped source tree', () => {
    it('contains no eslint-disable of this rule anywhere', async () => {
      // R2: "The lint rule that enforces this must not be disabled." A disable comment would make
      // `npm run lint` green while the rule protected nothing, so the absence is asserted rather
      // than assumed.
      const eslint = new ESLint({ cwd: BACK_END_ROOT });
      const results = await eslint.lintFiles(['src/**/*.ts']);

      const suppressed = results.flatMap((result) =>
        (result.suppressedMessages ?? []).filter((message) => message.ruleId === RULE),
      );

      expect(suppressed).toEqual([]);
    });
  });
});
