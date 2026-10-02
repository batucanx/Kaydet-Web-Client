import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Architecture boundaries (see CLAUDE.md → Architecture, and `scripts/check-boundaries.mjs` which enforces
 * the same rules on the import graph and package manifests):
 *
 *   packages/domain  pure TypeScript only — no React, DOM/Node APIs, IMAP/SMTP/SQLite, Fastify, apps/*
 *   apps/web         may use packages/domain; must never reach IMAP/SMTP/database infrastructure
 *   apps/server      may use packages/domain; must never import apps/web. Its layers point one way:
 *                      http → application ← infrastructure; only `compose.ts` wires implementations in.
 */
const INFRA_LIBS = [
  'imapflow', 'imap', 'imap-simple', 'node-imap', 'nodemailer', 'mailparser', 'mailcomposer', 'emailjs-*', 'smtp-server',
  'better-sqlite3', 'sqlite', 'sqlite3', 'node:sqlite', 'drizzle-orm', 'drizzle-orm/*', 'kysely', 'knex', 'pg', 'mysql2', 'typeorm', 'prisma', '@prisma/*',
  'fastify', 'fastify/*', '@fastify/*', 'express', 'koa', 'hono',
];
const NODE_BUILTINS = [
  'node:*', 'fs', 'fs/*', 'path', 'os', 'child_process', 'net', 'tls', 'dns', 'http', 'https', 'http2', 'stream', 'stream/*',
  'crypto', 'zlib', 'worker_threads', 'cluster', 'vm', 'readline', 'url', 'util',
];
const infraPattern = {
  group: [...INFRA_LIBS, '@kaydet/server', '**/apps/server/**'],
  message: 'Protocol/database/server infrastructure belongs to apps/server. The browser talks to the API contract only.',
};

// Server layering (mirrored by `scripts/check-boundaries.mjs`, which also covers non-import edges). Test files and
// `src/testing/` are exempt from the layer rules: they compose real adapters on purpose.
const webPattern = { group: ['@kaydet/web', '@kaydet/web/*', '**/apps/web/**'], message: 'The server must never import the web app.' };
const domainInternals = { group: ['@kaydet/domain/*', '**/packages/domain/**'], message: 'Import `@kaydet/domain` from its root entry only.' };
const httpFrameworks = ['fastify', 'fastify/*', '@fastify/*', 'express', 'koa', 'hono'];
const protocolDbLibs = INFRA_LIBS.filter((lib) => !httpFrameworks.includes(lib));
const serverTestFiles = ['apps/server/src/**/*.test.ts', 'apps/server/src/testing/**'];

const applicationPatterns = [
  webPattern,
  domainInternals,
  { group: ['**/http', '**/http/*', '**/http/**'], message: 'The application layer must not import HTTP.' },
  { group: ['**/infrastructure', '**/infrastructure/*', '**/infrastructure/**'], message: 'The application layer depends on ports, not adapters.' },
  { group: [...httpFrameworks, ...protocolDbLibs], message: 'The application layer must not depend on frameworks or protocol/database libraries.' },
  { group: ['node:*'], message: 'The application layer must not use Node built-ins (it speaks in ports).' },
];
const nodeBuiltinPaths = NODE_BUILTINS.filter((name) => !name.includes('*')).map((name) => ({ name, message: 'The application layer must not use Node built-ins (it speaks in ports).' }));

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.claude/**', 'packages/tokens/tokens.css'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Web: no infrastructure imports anywhere (a later, narrower block re-adds this pattern next to its own).
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [infraPattern] }] },
  },
  {
    // Mock data is an isolated, replaceable fixture: only the mock provider and tests may reference it.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/data/mock/**', 'apps/web/src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            infraPattern,
            { group: ['**/data/mock/*', '**/mock/*'], message: 'Mock data must not leak outside data/mock and tests.' },
          ],
        },
      ],
    },
  },
  {
    // Design-system guard: raw color literals are only allowed in the tokens package.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message: 'Raw hex colors are forbidden outside packages/tokens. Use a design token (CSS variable).',
        },
        {
          selector: 'Literal[value=/^(rgb|rgba|hsl|hsla)\\(/]',
          message: 'Raw color functions are forbidden outside packages/tokens. Use a design token.',
        },
      ],
    },
  },
  {
    // Domain: pure TypeScript. No UI, no browser or Node APIs, no protocol/database libraries, no apps.
    // (tsconfig additionally has no DOM/Node typings, so those APIs do not even type-check.)
    files: ['packages/domain/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react/*', 'react-dom', 'react-dom/*', 'react-router', 'react-router/*', 'react-router-dom', 'react-router-dom/*', '@radix-ui/*', 'lucide-react'], message: 'The domain package must not depend on React or UI libraries.' },
            infraPattern,
            { group: NODE_BUILTINS, message: 'The domain package must not use Node built-ins (it also runs in the browser).' },
            { group: ['**/apps/**', '@kaydet/web', '@kaydet/tokens'], message: 'The domain package must not import apps or the UI token package.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'process', 'Buffer', 'require', '__dirname', '__filename'].map(
          (name) => ({ name, message: `\`${name}\` is a browser/Node API; the domain package is pure TypeScript.` }),
        ),
      ],
    },
  },
  {
    files: ['apps/server/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-restricted-imports': ['error', { patterns: [webPattern, domainInternals] }],
    },
  },
  {
    // HTTP: transport only. Reaches use cases through the application layer; implementations arrive via compose.ts.
    files: ['apps/server/src/http/**/*.ts'],
    ignores: serverTestFiles,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            webPattern,
            domainInternals,
            { group: ['**/infrastructure', '**/infrastructure/*', '**/infrastructure/**'], message: 'HTTP must not import infrastructure; adapters are wired in compose.ts.' },
            { group: ['**/application/ports/**', '**/application/services/**', '**/application/use-cases/**'], message: 'HTTP reaches the application only through application/index.ts: it must not touch ports, hashing, keys or credentials.' },
            { group: protocolDbLibs, message: 'HTTP must not use IMAP/SMTP/database libraries directly.' },
          ],
        },
      ],
    },
  },
  {
    // Application: use cases + ports. No HTTP, no framework, no adapters, no Node APIs.
    files: ['apps/server/src/application/**/*.ts'],
    ignores: serverTestFiles,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...applicationPatterns,
          ],
          // Exact module names (a `crypto` PATTERN would also match the application's own `ports/crypto/` folder).
          paths: nodeBuiltinPaths,
        },
      ],
      'no-restricted-globals': ['error', ...['process', 'Buffer', 'require', '__dirname', '__filename'].map((name) => ({ name, message: `\`${name}\` is a Node API; the application layer is runtime-independent.` }))],
    },
  },
  {
    // Mail ports speak Kaydet concepts: no credential, security or crypto types cross them.
    files: ['apps/server/src/application/ports/mail/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...applicationPatterns,
            { group: ['**/security', '**/security/*', '**/security/**', '**/crypto/**', '**/*credential*'], message: 'Mail ports must not expose credential, security or crypto types.' },
          ],
          paths: nodeBuiltinPaths,
        },
      ],
    },
  },
  {
    // Infrastructure implements application ports; it never reaches into HTTP.
    files: ['apps/server/src/infrastructure/**/*.ts'],
    ignores: serverTestFiles,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            webPattern,
            domainInternals,
            { group: ['**/http', '**/http/*', '**/http/**'], message: 'Infrastructure must not import HTTP.' },
            { group: httpFrameworks, message: 'Infrastructure must not depend on the HTTP framework.' },
            { group: ['node:sqlite', 'better-sqlite3', 'sqlite3'], message: 'Only infrastructure/sqlite may use the SQLite driver.' },
          ],
        },
      ],
    },
  },
  {
    // The one place that owns the SQLite driver.
    files: ['apps/server/src/infrastructure/sqlite/**/*.ts'],
    ignores: serverTestFiles,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            webPattern,
            domainInternals,
            { group: ['**/http', '**/http/*', '**/http/**'], message: 'Infrastructure must not import HTTP.' },
            { group: httpFrameworks, message: 'Infrastructure must not depend on the HTTP framework.' },
          ],
        },
      ],
    },
  },
  {
    // Composition root, HTTP assembly and configuration: no database driver either (they use the persistence ports).
    files: ['apps/server/src/*.ts', 'apps/server/src/config/**/*.ts'],
    ignores: serverTestFiles,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            webPattern,
            domainInternals,
            { group: ['node:sqlite', 'better-sqlite3', 'sqlite3'], message: 'Only infrastructure/sqlite may use the SQLite driver.' },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'apps/server/scripts/**/*.mjs', 'packages/tokens/scripts/**/*.ts', 'packages/tokens/src/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
);
