// Architecture guard: verifies the package boundaries on the real import graph and package manifests.
//
//   packages/domain  pure TypeScript: relative imports inside itself, `zod`, and (tests only) `vitest`.
//                    No apps/*, no React/router, no IMAP/SMTP/SQLite/Fastify, no Node built-ins.
//   apps/web         may import `@kaydet/domain` (root entry only) and its own code; never protocol/database
//                    infrastructure, never apps/server, never domain internals.
//   apps/server      may import `@kaydet/domain` (root entry only); never apps/web. Inside it the layers point one way:
//                      http → application → (ports) ← infrastructure, with `compose.ts` as the only wiring point:
//                      - http cannot import infrastructure (nor protocol/database libraries)
//                      - application cannot import http, infrastructure, Fastify or Node built-ins
//                      - infrastructure cannot import http; config cannot import http/application/infrastructure
//                      - `app.ts` (HTTP assembly) cannot import infrastructure — only `compose.ts` does
//                      - HTTP reaches the application ONLY through `application/index.ts` (use cases + context types); it
//                        cannot import ports, services or use-case modules, so it cannot hash a password, see a key or
//                        decrypt a credential
//                      - the `application/index.ts` barrel does not EXPORT the security ports, crypto, the credential vault,
//                        the password hasher, user administration, the mail-store writer (provider identity) or the unit of work
//                      - mail ports (`application/ports/mail`) cannot import security/credential/crypto types
//                      - only `infrastructure/sqlite/` may touch the SQLite driver (`node:sqlite`, better-sqlite3…): not HTTP,
//                        not the application, not config/compose, not the other infrastructure adapters
//                    Tests and `src/testing/` are exempt (they compose real adapters on purpose).
//
// Usage: `node scripts/check-boundaries.mjs [--root <dir>]` (the root override lets the guard tests point it at fixtures).

// ESLint enforces the same at edit time (`eslint.config.js`); this script is the backstop that also checks
// dependencies declared in package.json and deep relative imports that escape a package.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArg = process.argv.indexOf('--root');
const root = rootArg > 0 && process.argv[rootArg + 1] ? resolve(process.argv[rootArg + 1]) : fileURLToPath(new URL('..', import.meta.url));
const at = (...p) => join(root, ...p);
const rel = (p) => relative(root, p).split(sep).join('/');

const INFRA = [
  /^imapflow$/, /^imap(-simple)?$/, /^node-imap$/, /^nodemailer$/, /^mailparser$/, /^mailcomposer$/, /^emailjs-/, /^smtp-server$/,
  /^better-sqlite3$/, /^sqlite3?$/, /^node:sqlite$/, /^drizzle-orm/, /^kysely$/, /^knex$/, /^pg$/, /^mysql2$/, /^typeorm$/, /^prisma$/, /^@prisma\//,
  /^fastify/, /^@fastify\//, /^express$/, /^koa$/, /^hono$/,
];
const NODE_BUILTIN = /^(node:|(fs|path|os|child_process|net|tls|dns|http2?|https|stream|crypto|zlib|worker_threads|cluster|vm|readline|url|util)(\/|$))/;
const REACT_UI = /^(react|react-dom|react-router(-dom)?|@radix-ui\/|lucide-react)(\/|$)/;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

/** Module specifiers of static imports/exports, dynamic `import()` and `require()`. */
function specifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const found = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) found.push(m[1]);
  return found;
}

const problems = [];
const report = (file, spec, why) => problems.push(`${rel(file)}: import "${spec}" — ${why}`);

const domainSrc = at('packages', 'domain', 'src');
const webSrc = at('apps', 'web', 'src');
const serverDir = at('apps', 'server');

function checkDomain(file) {
  const isTest = /\.test\.ts$/.test(file);
  for (const spec of specifiers(readFileSync(file, 'utf8'))) {
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec);
      if (!(target + sep).startsWith(domainSrc + sep) && target !== domainSrc) report(file, spec, 'escapes packages/domain/src');
      continue;
    }
    if (spec === 'zod' || spec.startsWith('zod/')) continue;
    if (isTest && spec === 'vitest') continue;
    if (REACT_UI.test(spec)) report(file, spec, 'the domain package must not depend on React/UI');
    else if (INFRA.some((re) => re.test(spec))) report(file, spec, 'protocol/database/server infrastructure is not allowed in the domain package');
    else if (NODE_BUILTIN.test(spec)) report(file, spec, 'Node built-ins are not allowed (the package also runs in the browser)');
    else if (/^@kaydet\/(web|server|tokens)/.test(spec) || /(^|\/)apps\//.test(spec)) report(file, spec, 'the domain package must not import apps or UI packages');
    else report(file, spec, 'only `zod` is an allowed external dependency of the domain package');
  }
}

function checkWeb(file) {
  for (const spec of specifiers(readFileSync(file, 'utf8'))) {
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec);
      if (!(target + sep).startsWith(webSrc + sep)) report(file, spec, 'relative import escapes apps/web/src (use a package import)');
      continue;
    }
    if (INFRA.some((re) => re.test(spec)) || /^@kaydet\/server/.test(spec) || /(^|\/)apps\/server/.test(spec)) {
      report(file, spec, 'the browser must never reach IMAP/SMTP/database/server infrastructure');
    } else if (NODE_BUILTIN.test(spec) && !/\.test\.tsx?$/.test(file) && !/vite\.config/.test(file)) {
      report(file, spec, 'Node built-ins do not belong in browser code');
    } else if (/^@kaydet\/domain\/.+/.test(spec)) {
      report(file, spec, 'import `@kaydet/domain` from its root entry, never from its internals');
    }
  }
}

const serverSrc = join(serverDir, 'src');
const SQLITE_DRIVERS = [/^node:sqlite$/, /^better-sqlite3$/, /^sqlite3?$/];
const HTTP_LIBS = [/^fastify/, /^@fastify\//, /^express$/, /^koa$/, /^hono$/];
const PROTOCOL_DB_LIBS = INFRA.filter((re) => !HTTP_LIBS.some((h) => h.source === re.source));

/** Layer of a server source file (or of an import target) by its first directory below `apps/server/src`. */
function serverLayer(path) {
  const inside = relative(serverSrc, path).split(sep);
  if (inside[0] === '..') return null;
  if (inside.length === 1) return `root:${inside[0]}`;
  return inside[0];
}

function checkServer(file) {
  const isTest = /\.test\.ts$/.test(file);
  const layer = serverLayer(file);
  const exempt = isTest || layer === 'testing';
  for (const spec of specifiers(readFileSync(file, 'utf8'))) {
    if (/^@kaydet\/web/.test(spec) || /(^|\/)apps\/web/.test(spec)) report(file, spec, 'the server must never import the web app');
    if (/^@kaydet\/domain\/.+/.test(spec)) report(file, spec, 'import `@kaydet/domain` from its root entry, never from its internals');

    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec);
      if ((target + sep).startsWith(at('apps', 'web') + sep)) report(file, spec, 'the server must never import the web app');
      if ((target + sep).startsWith(domainSrc + sep)) report(file, spec, 'import `@kaydet/domain`, not its source files');
      if (exempt) continue;
      const to = serverLayer(target);
      if (layer === 'http' && to === 'infrastructure') report(file, spec, 'HTTP must not import infrastructure; implementations are wired in compose.ts');
      if (layer === 'http' && to === 'application' && rel(target).replace(/\.ts$/, '') !== 'apps/server/src/application/index') {
        report(file, spec, 'HTTP may import the application only through application/index.ts (not ports, services or use-case modules)');
      }
      if (rel(file).startsWith('apps/server/src/application/ports/mail/') && /(security|credential|crypto)/i.test(spec)) {
        report(file, spec, 'mail ports must not expose credential, security or crypto types');
      }
      if (layer === 'application' && (to === 'http' || to === 'infrastructure')) report(file, spec, `the application layer must not import ${to}`);
      if (layer === 'infrastructure' && to === 'http') report(file, spec, 'infrastructure must not import HTTP');
      if (layer === 'config' && (to === 'http' || to === 'application' || to === 'infrastructure')) report(file, spec, `config must not import ${to}`);
      if (layer === 'root:app.ts' && to === 'infrastructure') report(file, spec, 'app.ts assembles HTTP over injected dependencies; only compose.ts imports infrastructure');
      continue;
    }
    if (exempt) continue;
    if (SQLITE_DRIVERS.some((re) => re.test(spec)) && !rel(file).startsWith('apps/server/src/infrastructure/sqlite/')) {
      report(file, spec, 'only infrastructure/sqlite may use the SQLite driver');
    }
    if (layer === 'http' && PROTOCOL_DB_LIBS.some((re) => re.test(spec))) report(file, spec, 'HTTP must not use protocol/database libraries directly');
    if (layer === 'application') {
      if (HTTP_LIBS.some((re) => re.test(spec))) report(file, spec, 'the application layer must not depend on Fastify or any HTTP framework');
      else if (PROTOCOL_DB_LIBS.some((re) => re.test(spec))) report(file, spec, 'the application layer must not depend on protocol/database libraries (ports are implemented in infrastructure)');
      else if (NODE_BUILTIN.test(spec)) report(file, spec, 'the application layer must not use Node built-ins (it speaks in ports)');
    }
    if (layer === 'infrastructure' && HTTP_LIBS.some((re) => re.test(spec))) report(file, spec, 'infrastructure must not depend on the HTTP framework');
  }
}


/** The barrel HTTP imports must not EXPORT anything security-sensitive. */
function checkApplicationBarrel() {
  const barrel = join(serverSrc, 'application', 'index.ts');
  if (!existsSync(barrel)) return;
  const source = readFileSync(barrel, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of source.matchAll(/\bexport\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
    if (/ports\/(security|crypto)\/|credential-vault|password-|user-administration|session-secrets|mail-store|unit-of-work/.test(m[1])) {
      report(barrel, m[1], 'the application barrel (imported by HTTP) must not export security ports, crypto, the credential vault, hashing, user administration, the mail-store writer (provider identity) or the unit of work');
    }
  }
}
checkApplicationBarrel();

for (const f of walk(domainSrc)) checkDomain(f);
for (const f of walk(webSrc)) checkWeb(f);
for (const f of walk(serverSrc)) checkServer(f);

// Manifests: what a package DECLARES must respect the same boundaries.
function manifest(...p) {
  const path = at(...p, 'package.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
const depsOf = (m) => Object.keys({ ...m?.dependencies, ...m?.devDependencies, ...m?.peerDependencies, ...m?.optionalDependencies });

const domainPkg = manifest('packages', 'domain');
if (domainPkg) {
  const runtime = Object.keys(domainPkg.dependencies ?? {});
  for (const dep of runtime) if (dep !== 'zod') problems.push(`packages/domain/package.json: runtime dependency "${dep}" — only zod is allowed`);
  for (const dep of depsOf(domainPkg)) {
    if (/^@kaydet\/(web|server|tokens)$/.test(dep)) problems.push(`packages/domain/package.json: depends on ${dep}`);
    if (REACT_UI.test(dep) || INFRA.some((re) => re.test(dep))) problems.push(`packages/domain/package.json: depends on ${dep}`);
  }
}
const webPkg = manifest('apps', 'web');
if (webPkg) {
  for (const dep of depsOf(webPkg)) {
    if (INFRA.some((re) => re.test(dep)) || dep === '@kaydet/server') problems.push(`apps/web/package.json: depends on ${dep} (infrastructure)`);
  }
}
const serverPkg = manifest('apps', 'server');
if (serverPkg && depsOf(serverPkg).includes('@kaydet/web')) problems.push('apps/server/package.json: depends on @kaydet/web');

if (problems.length > 0) {
  console.error(`Architecture boundary violations (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('Architecture boundaries OK (domain is pure; web has no infrastructure access; server layers point inward and never reach web).');
