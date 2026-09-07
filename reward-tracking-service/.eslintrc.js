/**
 * T-RTS-001. Matches portal/back-end's own ESLint convention — the same idiom already used by
 * promo-code-service's, RAP's and reward-redemption-service's own `.eslintrc.js`
 * (ARCHITECTURE.md §4 — "same team, same conventions, same reviewers reading the code, no reason
 * to diverge") — so an agent moving between these projects doesn't have to relearn a second lint
 * setup. Append rules here as later waves need them — do not replace this file wholesale.
 *
 * `@typescript-eslint/no-explicit-any: 'error'` enforces AGENT-PROTOCOL.md R9 ("No `any`, no
 * `@ts-ignore`, no disabled lint rule without a comment naming the task id and the reason") at
 * the tooling level, not just by convention.
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
  ignorePatterns: ['.eslintrc.js', 'dist', 'node_modules'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
};
