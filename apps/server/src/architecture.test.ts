/**
 * Automated architecture guards. The rules live in `scripts/check-boundaries.mjs` (import graph + manifests) and
 * `eslint.config.js` (edit-time); these tests prove that both actually FAIL when a boundary is crossed, so the
 * guards cannot silently rot into no-ops.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repoRoot, 'scripts', 'check-boundaries.mjs');

const fixtures: string[] = [];
afterAll(() => fixtures.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Runs the boundary script against a throw-away repo containing exactly `files`. */
function runGuard(files: Record<string, string>): { ok: boolean; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'kaydet-boundaries-'));
  fixtures.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

const S = 'apps/server/src';

/**
 * Source text of a module importing each of `specs`. Built without a literal `import … from '…'` in THIS file, so the
 * boundary script (which scans every server source file, tests included) does not mistake fixtures for real imports.
 */
const imp = (...specs: string[]): string => specs.map((spec, i) => `import { X${i} } ${'from'} '${spec}';`).join('\n');
const exp = (...specs: string[]): string => specs.map((spec, i) => `export { X${i} } ${'from'} '${spec}';`).join('\n');
const mod = (spec: string): string => `${imp(spec)}\nexport const y = X0;\n`;

describe('boundary script on the real repository', () => {
  it('passes', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: repoRoot });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('boundary script: server layers', () => {
  const violations: Array<[string, Record<string, string>, RegExp]> = [
    ['HTTP importing infrastructure', { [`${S}/http/route.ts`]: imp('../infrastructure/memory/index.ts') }, /HTTP must not import infrastructure/],
    ['HTTP using an IMAP library', { [`${S}/http/route.ts`]: imp('imapflow') }, /HTTP must not use protocol\/database libraries/],
    ['HTTP using SQLite', { [`${S}/http/route.ts`]: imp('better-sqlite3') }, /HTTP must not use protocol\/database libraries/],
    ['HTTP importing an application port', { [`${S}/http/route.ts`]: imp('../application/ports/security/index.ts') }, /only through application\/index\.ts/],
    ['HTTP importing an application service (vault, hasher…)', { [`${S}/http/route.ts`]: imp('../application/services/credential-vault.ts') }, /only through application\/index\.ts/],
    ['HTTP importing a use-case module directly', { [`${S}/http/route.ts`]: imp('../application/use-cases/accounts.ts') }, /only through application\/index\.ts/],
    ['the application barrel exporting the credential vault', { [`${S}/application/index.ts`]: exp('./services/credential-vault.ts') }, /barrel .* must not export security ports/],
    ['the application barrel exporting the crypto port', { [`${S}/application/index.ts`]: exp('./ports/crypto/crypto.ts') }, /barrel .* must not export security ports/],
    ['the application barrel exporting the password hasher port', { [`${S}/application/index.ts`]: exp('./ports/security/password-hasher.ts') }, /barrel .* must not export security ports/],
    ['the application barrel exporting the mail-store writer (provider identity)', { [`${S}/application/index.ts`]: exp('./ports/repositories/mail-store.ts') }, /barrel .* must not export security ports/],
    ['the application barrel exporting the unit of work', { [`${S}/application/index.ts`]: exp('./ports/transaction/unit-of-work.ts') }, /barrel .* must not export security ports/],
    ['a mail port importing a credential type', { [`${S}/application/ports/mail/x.ts`]: imp('../security/mail-credential.ts') }, /mail ports must not expose credential/],
    ['a mail port importing the crypto port', { [`${S}/application/ports/mail/x.ts`]: imp('../crypto/crypto.ts') }, /mail ports must not expose credential/],
    ['HTTP importing the SQLite driver', { [`${S}/http/route.ts`]: imp('node:sqlite') }, /SQLite driver|protocol\/database/],
    ['HTTP importing a third-party SQLite library', { [`${S}/http/route.ts`]: imp('better-sqlite3') }, /SQLite driver|protocol\/database/],
    ['the application layer importing the SQLite driver', { [`${S}/application/use.ts`]: imp('node:sqlite') }, /SQLite driver|Node built-ins|protocol\/database/],
    ['the composition root importing the SQLite driver', { [`${S}/compose.ts`]: imp('node:sqlite') }, /only infrastructure\/sqlite may use the SQLite driver/],
    ['config importing the SQLite driver', { [`${S}/config/c.ts`]: imp('node:sqlite') }, /only infrastructure\/sqlite may use the SQLite driver/],
    ['another infrastructure adapter importing the SQLite driver', { [`${S}/infrastructure/memory/m.ts`]: imp('node:sqlite') }, /only infrastructure\/sqlite may use the SQLite driver/],
    ['application importing HTTP', { [`${S}/application/use.ts`]: imp('../http/route.ts') }, /application layer must not import http/],
    ['application importing infrastructure', { [`${S}/application/use.ts`]: imp('../infrastructure/x.ts') }, /application layer must not import infrastructure/],
    ['application importing Fastify', { [`${S}/application/use.ts`]: imp('fastify') }, /must not depend on Fastify/],
    ['application importing a Fastify plugin', { [`${S}/application/use.ts`]: imp('@fastify/cors') }, /must not depend on Fastify/],
    ['application importing nodemailer', { [`${S}/application/use.ts`]: imp('nodemailer') }, /protocol\/database libraries/],
    ['application using a Node built-in', { [`${S}/application/use.ts`]: imp('node:crypto') }, /Node built-ins/],
    ['infrastructure importing HTTP', { [`${S}/infrastructure/a.ts`]: imp('../http/route.ts') }, /infrastructure must not import HTTP/],
    ['infrastructure importing Fastify', { [`${S}/infrastructure/a.ts`]: imp('fastify') }, /must not depend on the HTTP framework/],
    ['config importing the application', { [`${S}/config/c.ts`]: imp('../application/index.ts') }, /config must not import application/],
    ['app.ts importing infrastructure', { [`${S}/app.ts`]: imp('./infrastructure/memory/index.ts') }, /only compose\.ts imports infrastructure/],
    ['the server importing the web app (package)', { [`${S}/x.ts`]: imp('@kaydet/web') }, /server must never import the web app/],
    ['the server importing the web app (relative)', { [`${S}/x.ts`]: imp('../../web/src/main.tsx') }, /server must never import the web app/],
    ['the server importing domain internals', { [`${S}/x.ts`]: imp('@kaydet/domain/src/api/dto.ts') }, /root entry/],
    ['the server importing domain source files', { [`${S}/x.ts`]: imp('../../../packages/domain/src/api/dto.ts') }, /import `@kaydet\/domain`/],
  ];
  for (const [name, files, message] of violations) {
    it(`rejects ${name}`, () => {
      const result = runGuard(files);
      expect(result.ok, result.output).toBe(false);
      expect(result.output).toMatch(message);
    });
  }

  it('allows the legal directions and exempts tests and src/testing', () => {
    const result = runGuard({
      [`${S}/http/route.ts`]: imp('fastify'),
      [`${S}/application/use.ts`]: imp('./x.ts'),
      [`${S}/infrastructure/mem.ts`]: imp('node:crypto'),
      [`${S}/compose.ts`]: imp('./infrastructure/mem.ts'),
      [`${S}/infrastructure/sqlite/db.ts`]: imp('node:sqlite'),
      [`${S}/http/route.test.ts`]: imp('../infrastructure/mem.ts'),
      [`${S}/testing/harness.ts`]: imp('../infrastructure/mem.ts'),
    });
    expect(result.ok, result.output).toBe(true);
  });
});

describe('boundary script: domain and web', () => {
  it('domain cannot import the server, Node built-ins or web', () => {
    for (const source of [imp('node:sqlite'), imp('../../../../apps/server/src/app.ts'), imp('node:fs'), imp('@kaydet/server'), imp('fastify')]) {
      const result = runGuard({ 'packages/domain/src/a.ts': source });
      expect(result.ok, source).toBe(false);
    }
  });

  it('web cannot import server code or infrastructure', () => {
    for (const source of [imp('@kaydet/server'), imp('../../../server/src/infrastructure/memory/index.ts'), imp('fastify'), imp('better-sqlite3'), imp('imapflow')]) {
      const result = runGuard({ 'apps/web/src/a.ts': source });
      expect(result.ok, source).toBe(false);
    }
  });

  it('manifests: the server must not depend on the web app, the domain must not depend on the server', () => {
    const serverManifest = runGuard({ 'apps/server/package.json': JSON.stringify({ dependencies: { '@kaydet/web': '*' } }) });
    expect(serverManifest.ok).toBe(false);
    const domainManifest = runGuard({ 'packages/domain/package.json': JSON.stringify({ dependencies: { zod: '*', fastify: '*' } }) });
    expect(domainManifest.ok).toBe(false);
  });
});

describe('ESLint enforces the same layers at edit time', () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const lint = async (filePath: string, code: string) =>
    (await eslint.lintText(code, { filePath: join(repoRoot, filePath) }))[0]?.messages.map((m) => m.message).join('\n') ?? '';

  it('HTTP cannot import infrastructure', async () => {
    expect(await lint('apps/server/src/http/x.ts', mod('../infrastructure/memory/index.ts'))).toMatch(/HTTP must not import infrastructure/);
  });

  it('the application layer cannot import Fastify, HTTP, adapters or Node built-ins', async () => {
    const cases: Array<[string, RegExp]> = [
      ['fastify', /frameworks/],
      ['../http/x.ts', /must not import HTTP/],
      ['../infrastructure/x.ts', /ports, not adapters/],
      ['node:crypto', /Node built-ins/],
      ['crypto', /Node built-ins/],
    ];
    for (const [spec, pattern] of cases) expect(await lint('apps/server/src/application/x.ts', mod(spec)), spec).toMatch(pattern);
  });

  it('HTTP cannot import application ports; mail ports cannot import credential types', async () => {
    expect(await lint('apps/server/src/http/x.ts', mod('../application/ports/security/index.ts'))).toMatch(/only through application\/index\.ts/);
    expect(await lint('apps/server/src/http/x.ts', mod('../application/services/credential-vault.ts'))).toMatch(/only through application\/index\.ts/);
    expect(await lint('apps/server/src/application/ports/mail/x.ts', mod('../security/mail-credential.ts'))).toMatch(/must not expose credential/);
    expect(await lint('apps/server/src/application/ports/mail/x.ts', mod('fastify'))).toMatch(/frameworks/); // still an application file
  });

  it('only infrastructure/sqlite may import the SQLite driver (ESLint)', async () => {
    expect(await lint('apps/server/src/http/x.ts', mod('node:sqlite'))).toMatch(/SQLite|IMAP\/SMTP\/database/);
    expect(await lint('apps/server/src/application/x.ts', mod('node:sqlite'))).toMatch(/Node built-ins|SQLite/);
    expect(await lint('apps/server/src/compose.ts', mod('node:sqlite'))).toMatch(/Only infrastructure\/sqlite/);
    expect(await lint('apps/server/src/config/x.ts', mod('node:sqlite'))).toMatch(/Only infrastructure\/sqlite/);
    expect(await lint('apps/server/src/infrastructure/memory/x.ts', mod('node:sqlite'))).toMatch(/Only infrastructure\/sqlite/);
    expect(await lint('apps/server/src/infrastructure/sqlite/x.ts', mod('node:sqlite'))).toBe('');
    expect(await lint('packages/domain/src/x.ts', mod('node:sqlite'))).toMatch(/Node built-ins|database/);
    expect(await lint('apps/web/src/x.ts', mod('node:sqlite'))).toMatch(/infrastructure|database/i);
  });

  it('the application layer may keep its own `ports/crypto` folder (a name that is also a Node built-in)', async () => {
    expect(await lint('apps/server/src/application/x.ts', mod('./ports/crypto/crypto.ts'))).toBe('');
  });

  it('infrastructure cannot import HTTP; the server cannot import the web app', async () => {
    expect(await lint('apps/server/src/infrastructure/x.ts', mod('../http/x.ts'))).toMatch(/must not import HTTP/);
    expect(await lint('apps/server/src/compose.ts', mod('@kaydet/web'))).toMatch(/must never import the web app/);
  });

  it('the domain package cannot use Node APIs; the web app cannot import the server', async () => {
    expect(await lint('packages/domain/src/x.ts', mod('node:fs'))).toMatch(/Node built-ins/);
    expect(await lint('apps/web/src/x.ts', mod('@kaydet/server'))).toMatch(/infrastructure/);
  });
});
