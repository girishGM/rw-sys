module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'plugin:prettier/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs', 'node_modules'],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    '@typescript-eslint/no-explicit-any': 'error',
    'no-restricted-globals': [
      'error',
      {
        name: 'localStorage',
        // AGENT-PROTOCOL.md R5 / 02-SECURITY.md: no auth token anywhere JS can read it.
        // If a legitimate non-auth use ever needs localStorage, it must be reviewed and
        // this rule adjusted deliberately — never silently worked around.
        message:
          'No auth token may live in localStorage (AGENT-PROTOCOL R5). Cookies only. If this is a genuinely non-auth use, get it reviewed before disabling this rule.',
      },
      {
        name: 'sessionStorage',
        message: 'Same rule as localStorage — see AGENT-PROTOCOL.md R5.',
      },
    ],
  },
};
