/**
 * T-013 appends the `no-restricted-syntax` rule banning raw Model access outside
 * src/common/scope/ and src/database/ — see AGENT-PROTOCOL.md R2. Append to this file;
 * do not replace it, and never disable this rule to make a task's own code pass lint.
 */
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    sourceType: 'module',
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: ['plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended'],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.cjs', 'dist', 'node_modules'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],

    // --- T-013: no-raw-model-access (AGENT-PROTOCOL.md R2, 02-SECURITY.md §5) ----------------
    //
    // "Never bypass ScopedRepository. No direct Model.findAll/findOne/update/destroy in a
    // service. The lint rule that enforces this must not be disabled."
    //
    // This is the mechanical half of the multi-tenancy guarantee: `ScopedRepository` can only
    // be the single door to the data if there is no second door, and code review alone does not
    // reliably notice a `Campaign.findAll()` added three months from now in an unrelated PR.
    //
    // ### Why two selectors instead of the one the task file sketches
    //
    // T-013 implementation note 8 gives an illustrative selector matching
    // `findAll|findOne|findByPk|update|destroy|create` on *any* receiver. Applied verbatim it
    // flags correct, security-critical code that has nothing to do with Sequelize —
    // `createHash(...).update(value)` and `cipher.update(plaintext)` in `src/common/crypto`,
    // `createHmac(...).update(...)` in `blind-index.service.ts`, `token.service.ts`'s digest
    // helpers. The only ways to ship that are to sprinkle `eslint-disable` through the crypto
    // core — which R2 forbids in the same sentence, and which would be a far worse outcome than
    // the rule it was appeasing — or to make the selector precise. This does the latter, and
    // ends up banning strictly *more* real bypasses than the sketch (`findAndCountAll`,
    // `bulkCreate`, `upsert`, `findOrCreate`, `increment`, `restore`, aggregate helpers).
    //
    //  1. Method names that belong to no API but Sequelize's, on any receiver — so
    //     `Campaign.findAll()`, `this.model.findOne()` and `repo.findByPk()` are all caught.
    //  2. The ambiguous verbs (`create`, `update`, `destroy`, `count`, …) only when the receiver
    //     is a PascalCase identifier, i.e. a model class — `Campaign.update()` — with the JS
    //     built-ins that also start uppercase excluded by name.
    //
    // Exempted below, and nowhere else: `src/common/scope/` (the implementation of the rule),
    // `src/database/` (models, migrations and the connection itself), and `test/` (a test must
    // build its own fixtures and verify rows independently — a test that checked
    // `ScopedRepository` by asking `ScopedRepository` would prove nothing).
    'no-restricted-syntax': [
      'error',
      {
        selector:
          'CallExpression[callee.property.name=/^(findAll|findOne|findByPk|findAndCountAll|findOrCreate|bulkCreate|upsert)$/]',
        message:
          'Raw Sequelize model access is banned (AGENT-PROTOCOL R2). Use ScopedRepository so the ' +
          "actor's tenancy scope is applied in the WHERE clause. Do not disable this rule.",
      },
      {
        selector:
          'CallExpression[callee.object.name=/^[A-Z][A-Za-z0-9]*$/]' +
          // JS built-ins and framework factories that are PascalCase but are not Sequelize
          // models. Every addition to this list must be a type that has no `findAll`.
          ':not([callee.object.name=/^(Array|Boolean|Buffer|Date|Error|JSON|Map|Math|NestFactory|Number|Object|Promise|Reflect|Set|String|Symbol|WeakMap|WeakSet)$/])' +
          '[callee.property.name=/^(create|update|destroy|count|restore|increment|decrement|max|min|sum|truncate|bulkBuild)$/]',
        message:
          'Raw Sequelize model access is banned (AGENT-PROTOCOL R2). Use ScopedRepository so the ' +
          "actor's tenancy scope is applied in the WHERE clause. Do not disable this rule.",
      },
    ],
  },
  overrides: [
    {
      // The only places a raw model static is legitimate. See the rule's comment above; adding
      // a fourth entry here is a security decision, not a convenience.
      files: ['src/common/scope/**/*.ts', 'src/database/**/*.ts', 'test/**/*.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
};
