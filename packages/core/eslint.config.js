import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Edge-safety: core must run on Web APIs only (no node: builtins / Buffer / process).
const FORBIDDEN_NODE = [
  'fs',
  'path',
  'os',
  'stream',
  'http',
  'https',
  'net',
  'crypto',
  'child_process',
  'util',
  'buffer',
  'events',
  'url',
  'zlib',
  'process',
  'worker_threads',
  'perf_hooks',
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'examples/**', 'docs/**', 'skills/**'] },
  ...tseslint.configs.recommended,
  {
    // Allow underscore-prefixed unused params/vars (stub seams in Faz 0).
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Edge-safety rules apply to CORE src only.
    files: ['src/**/*.ts'],
    ignores: [
      'src/mcp/stdio.ts',
      'src/node/**',
      'src/rag-node.ts',
      'src/skills/node.ts',
      'src/memory-markdown.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: FORBIDDEN_NODE.map((name) => ({
            name,
            message:
              'Core must be edge-safe — no node builtins. Node-only code belongs in src/mcp/stdio.ts or src/node/.',
          })),
          patterns: [
            { group: ['node:*'], message: 'No node: protocol imports in edge-safe core.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message: 'Inject via Dependencies (deps), do not read process directly.',
        },
        { name: 'Buffer', message: 'Use Uint8Array / TextEncoder — no Buffer in edge-safe core.' },
        { name: '__dirname', message: 'No __dirname in edge-safe core.' },
        { name: '__filename', message: 'No __filename in edge-safe core.' },
      ],
      // Force "inject everything" discipline — no ambient non-determinism / console.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'Use deps.clock.now() — Date.now() is non-deterministic (defaultClock excepted).',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'Inject randomness via Dependencies — Math.random() breaks deterministic tests.',
        },
        {
          selector:
            "CallExpression[callee.object.name='crypto'][callee.property.name='randomUUID']",
          message:
            'Use deps.generateId() — crypto.randomUUID() is non-deterministic (defaultGenerateId excepted).',
        },
        {
          selector:
            "CallExpression[callee.object.name='crypto'][callee.property.name='getRandomValues']",
          message:
            'Inject randomness via Dependencies — crypto.getRandomValues() breaks deterministic tests.',
        },
        {
          selector: "MemberExpression[object.name='console']",
          message: 'Use deps.logger, not console, in edge-safe core.',
        },
      ],
    },
  },
  {
    // Node-only surfaces may use node builtins.
    files: [
      'src/mcp/stdio.ts',
      'src/node/**/*.ts',
      'src/rag-node.ts',
      'src/skills/node.ts',
      'src/memory-markdown.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    // Config + tests are not shipped to edge runtimes.
    files: ['*.config.ts', 'test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  prettier,
);
