/**
 * Structural guarantees that keep credentials out of the browser-facing surface, checked against the contract and the
 * sources — so a future change that would leak a secret fails a test instead of relying on review.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MailEventSchema, api } from '@kaydet/domain';
import type { ApiRouteName } from '@kaydet/domain';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('.', import.meta.url));

/** Every property name that appears anywhere in a schema's JSON Schema. */
function propertyNames(schema: z.ZodType): Set<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) for (const name of Object.keys(value)) names.add(name);
      visit(value);
    }
  };
  visit(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }));
  return names;
}

const FORBIDDEN = ['password', 'passwordhash', 'secret', 'credential', 'credentials', 'ciphertext', 'encryptedsecret', 'privatekey', 'encryptionkey', 'accesstoken', 'refreshtoken', 'authtag', 'iv', 'keyid', 'csrf', 'csrftoken', 'sessionid', 'secretfingerprint', 'username', 'imap', 'smtp', 'host', 'port'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}
const text = (path: string) => readFileSync(path, 'utf8');

describe('credentials cannot flow into API responses or events', () => {
  it('no response schema of the contract can carry a credential, key, hash or session internal', () => {
    for (const name of Object.keys(api) as ApiRouteName[]) {
      const response = api[name].response;
      if (!(response instanceof z.ZodType)) continue;
      const found = [...propertyNames(response)].filter((p) => FORBIDDEN.includes(p.toLowerCase()));
      expect(found, `response of ${name}`).toEqual([]);
    }
  });

  it('no server-sent event can carry one either', () => {
    expect([...propertyNames(MailEventSchema)].filter((p) => FORBIDDEN.includes(p.toLowerCase()))).toEqual([]);
  });

  it('the only response that carries a `token` is the undo handle (an unguessable id for a mail action, not a credential)', () => {
    const withToken = (Object.keys(api) as ApiRouteName[]).filter((name) => {
      const response = api[name].response;
      return response instanceof z.ZodType && propertyNames(response).has('token');
    });
    expect(withToken).toEqual(['applyMessageActions']);
  });

  it('the write-only account fields exist in requests, and only in requests', () => {
    expect([...propertyNames(api.createAccount.body as z.ZodType)]).toEqual(expect.arrayContaining(['password', 'username', 'imap', 'smtp']));
    expect([...propertyNames(api.createAccount.response)].sort()).toEqual(['displayName', 'email', 'id', 'lastSyncAt', 'status', 'supportsServerLabels', 'sync'].sort());
  });
});

describe('the HTTP layer cannot reach keys, hashing or decryption', () => {
  const http = [...walk(join(src, 'http')), join(src, 'app.ts')];

  it('never mentions key material, secrets configuration, hashing or decryption', () => {
    const forbidden = /credentialKeys|ServerSecrets|CredentialKeyConfig|KeyProvider|PasswordHasher|Argon2|CryptoPort|AesGcm|decrypt\(|encrypt\(|MailCredential|CredentialVault|MailCredentialResolver/; // (`passwordHash` appears in app.ts only as a log-redaction path)
    for (const file of http) expect(text(file), file).not.toMatch(forbidden);
  });

  it('receives the public configuration only: ServerConfig has no secret-bearing field', () => {
    const types = text(join(src, 'config', 'config.types.ts'));
    const serverConfig = /export interface ServerConfig[\s\S]*?\r?\n}\r?\n/.exec(types)?.[0] ?? '';
    expect(serverConfig.length).toBeGreaterThan(100);
    expect(serverConfig).not.toMatch(/credentialKeys|secrets?:|keys:/);
  });

  it('the composition root is the only module that reads secrets', () => {
    const readers = walk(src)
      .filter((f) => !f.includes(`${join(src, 'config')}`) && !f.includes(join(src, 'testing')))
      .filter((f) => /ServerSecrets|credentialKeys|CredentialKeyConfig/.test(text(f)))
      .map((f) => f.slice(src.length).replaceAll('\\', '/'));
    expect(readers.sort()).toEqual(['compose.ts', 'infrastructure/crypto/key-provider.ts', 'server.ts']); // main.ts only forwards the opaque `secrets` value
  });
});

describe('the application layer never touches the environment or crypto libraries', () => {
  const application = walk(join(src, 'application'));

  it('does not read process.env or use Node crypto', () => {
    for (const file of application) {
      const code = text(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/process\.env|from 'node:|from 'crypto'|require\(/);
    }
  });

  it('nothing in the application layer logs (secrets have no path to a log line from here)', () => {
    for (const file of application) expect(text(file).replace(/\/\/.*$/gm, ''), file).not.toMatch(/console\.|logger\.|\.log\(/);
  });
});

describe('mail ports do not expose credentials', () => {
  it('the mailbox and sender ports mention no credential, password or secret', () => {
    for (const file of ['mailbox.ts', 'sender.ts']) {
      const code = text(join(src, 'application', 'ports', 'mail', file)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/credential|password|secret|username/i);
    }
  });
});

describe('SQL and the database driver stay in infrastructure/sqlite', () => {
  const sql = /\b(SELECT\s[\s\S]*?\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIRTUAL)|ALTER\s+TABLE|DROP\s+TABLE|PRAGMA\s+\w+)\b/;
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('no SQL statement appears in HTTP, the application layer, the domain-facing config or the composition root', () => {
    const files = [...walk(join(src, 'http')), ...walk(join(src, 'application')), ...walk(join(src, 'config')), join(src, 'app.ts'), join(src, 'compose.ts'), join(src, 'server.ts'), join(src, 'main.ts')];
    for (const file of files) expect(strip(text(file)), file).not.toMatch(sql);
  });

  it('nothing outside infrastructure/sqlite mentions the driver, a database handle or a transaction primitive', () => {
    const outside = walk(src).filter((f) => !f.replaceAll('\\', '/').includes('/infrastructure/sqlite/') && !f.replaceAll('\\', '/').includes('/testing/'));
    for (const file of outside) {
      const code = strip(text(file));
      expect(code, file).not.toMatch(/node:sqlite|DatabaseSync|SqliteDatabase|BEGIN IMMEDIATE|\.prepare\(/);
    }
  });

  it('HTTP never sees a repository, a database handle or the persistence bundle', () => {
    for (const file of [...walk(join(src, 'http')), join(src, 'app.ts')]) {
      expect(strip(text(file)), file).not.toMatch(/Sqlite|MailStoreWriter|ProviderMessageRef|ProviderFolderRef|Persistence|UnitOfWork|openPersistence/);
    }
  });

  it('the repositories that HTTP-facing code depends on cannot return provider identity: their types have no such field', () => {
    for (const file of ['message-repository.ts', 'folder-repository.ts']) {
      const code = strip(text(join(src, 'application', 'ports', 'repositories', file)));
      expect(code, file).not.toMatch(/uidValidity|providerRef|modSeq|messageIdHeader|ProviderMessageRef/i);
    }
  });
});
