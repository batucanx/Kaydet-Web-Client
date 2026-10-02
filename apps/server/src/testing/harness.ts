/**
 * Test harness: the real application composed over in-memory adapters, a fake clock and a recording event bus.
 * Security is REAL here — Argon2id hashing, hashed server-side sessions, AES-256-GCM credentials, CSRF — nothing is
 * weakened to make tests fast. (Seed users share one precomputed real Argon2id hash, so building a harness stays cheap.)
 */
import type { MailEvent } from '@kaydet/domain';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../app.ts';
import type { AddressedEvent, ApplicationPorts, Clock, EventBus, EventListener, IdGenerator, Unsubscribe } from '../application/index.ts';
import type { AccountRepository } from '../application/index.ts';
import { compose } from '../compose.ts';
import { loadConfiguration } from '../config/index.ts';
import { InMemoryEventBus } from '../infrastructure/events/in-memory-event-bus.ts';
import { createMemoryPersistence } from '../infrastructure/memory/index.ts';
import { Argon2PasswordHasher } from '../infrastructure/security/argon2-password-hasher.ts';
import { NodeSessionSecrets } from '../infrastructure/security/node-session-secrets.ts';
import { USER_A, USER_B, seed } from './fixtures.ts';

export class FakeClock implements Clock {
  private current: number;
  constructor(start = '2026-09-30T12:00:00.000Z') {
    this.current = Date.parse(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `id-${this.n}`;
  }
}

/** Event bus that remembers everything published (and still delivers to subscribers). */
export class RecordingEventBus implements EventBus {
  readonly published: AddressedEvent[] = [];
  private readonly inner = new InMemoryEventBus();
  publish(userId: string, event: MailEvent): void {
    this.published.push({ userId, event });
    this.inner.publish(userId, event);
  }
  subscribe(listener: EventListener): Unsubscribe {
    return this.inner.subscribe(listener);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

/** The password of both seeded users. A test fixture, not a secret. */
export const SEED_PASSWORD = 'correct horse battery staple';
export const SEED_IDENTIFIERS = { a: 'a@kaydet.test', b: 'b@kaydet.test' } as const;

let seedHash: Promise<string> | undefined;
/** One real Argon2id hash of `SEED_PASSWORD`, computed once per test process. */
const seedPasswordHash = () => (seedHash ??= new Argon2PasswordHasher().hash(SEED_PASSWORD));

/** An `AccountRepository` for tests that need a failing/scripted one: unset methods answer "nothing there". */
export const accountsWith = (over: Partial<AccountRepository>): AccountRepository => ({
  listByUser: () => Promise.resolve([]),
  findOwned: () => Promise.resolve(null),
  create: () => Promise.reject(new Error('not scripted')),
  update: () => Promise.reject(new Error('not scripted')),
  remove: () => Promise.resolve(),
  ...over,
});

export interface TestApplicationOptions {
  /** Environment overrides on top of `NODE_ENV=test`. */
  readonly env?: Record<string, string>;
  /** Replace any port (a failing repository, a scripted mailbox…). */
  readonly ports?: Partial<ApplicationPorts>;
  /** Seed accounts/folders/messages and the two users (default true). */
  readonly seed?: boolean;
}

/** The whole application (no HTTP) over in-memory adapters, plus seeded users and sessions. */
export async function createTestApplication(options: TestApplicationOptions = {}) {
  const { config, secrets: serverSecrets } = loadConfiguration({ NODE_ENV: 'test', ...options.env });
  const clock = new FakeClock();
  const memory = createMemoryPersistence();
  const events = new RecordingEventBus();
  const secrets = new NodeSessionSecrets();
  if (options.seed !== false) {
    seed(memory);
    const passwordHash = await seedPasswordHash();
    for (const [id, identifier] of [[USER_A, SEED_IDENTIFIERS.a], [USER_B, SEED_IDENTIFIERS.b]] as const) {
      await memory.users.create({ id, identifier, passwordHash, createdAt: clock.now(), updatedAt: clock.now() });
    }
  }

  const composition = compose(config, {
    secrets: serverSecrets,
    ports: {
      clock,
      ids: new SequentialIds(),
      events,
      users: memory.users,
      sessions: memory.sessions,
      accounts: memory.accounts,
      credentialRecords: memory.credentialRecords,
      folders: memory.folders,
      messages: memory.messages,
      drafts: memory.drafts,
      outbox: memory.outbox,
      labels: memory.labels,
      signatures: memory.signatures,
      templates: memory.templates,
      blobs: memory.blobs,
      ...options.ports,
    },
  });
  const tokens = {
    a: (await composition.services.auth.issueSession(USER_A)).token,
    b: (await composition.services.auth.issueSession(USER_B)).token,
  };
  return { config, clock, memory, events, secrets, composition, services: composition.services, useCases: composition.useCases, tokens };
}
export type TestApplication = Awaited<ReturnType<typeof createTestApplication>>;

export interface RequestOptions {
  /** `'a'`/`'b'` = the seeded users' sessions; `'none'` = no cookie; any other string is sent as the raw session token. */
  readonly as?: 'a' | 'b' | 'none' | (string & {});
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly query?: Record<string, string>;
  /** CSRF header: `false` = send none; a string = send exactly this; default = the correct token of `as`. */
  readonly csrf?: false | string;
}

/** `request(method, url, options)` over `app.inject`, with the seeded users' cookies and CSRF tokens filled in. */
export function makeRequester(app: FastifyInstance, application: { config: { cookie: { name: string }; apiPrefix: string }; tokens: { a: string; b: string }; secrets: NodeSessionSecrets }) {
  const { config, tokens, secrets } = application;
  const tokenOf = (as: string): string => (as === 'a' ? tokens.a : as === 'b' ? tokens.b : as);
  return async function request(method: InjectOptions['method'], url: string, opts: RequestOptions = {}) {
    const as = opts.as ?? 'a';
    const headers: Record<string, string> = { ...opts.headers };
    if (as !== 'none') {
      const token = tokenOf(as);
      headers['cookie'] = `${config.cookie.name}=${token}`;
      if (opts.csrf !== false && headers['x-csrf-token'] === undefined) headers['x-csrf-token'] = opts.csrf ?? secrets.csrfToken(token);
    }
    const response = await app.inject({
      method,
      url: url.startsWith('/health') || url.startsWith('/ready') ? url : `${config.apiPrefix}${url}`,
      headers,
      ...(opts.query === undefined ? {} : { query: opts.query }),
      ...(opts.body === undefined ? {} : { payload: opts.body as object }),
    });
    let json: unknown;
    try {
      json = response.body === '' ? undefined : JSON.parse(response.body);
    } catch {
      json = undefined;
    }
    return { status: response.statusCode, headers: response.headers, json, text: response.body, raw: response };
  };
}

export async function createHarness(options: TestApplicationOptions = {}) {
  const application = await createTestApplication(options);
  const logLines: string[] = [];
  const app: FastifyInstance = await buildApp(application.composition, { logStream: { write: (line) => void logLines.push(line) } });
  await app.ready();
  const request = makeRequester(app, application);

  return {
    ...application,
    app,
    logLines,
    logs: () => logLines.filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>),
    request,
    /** Issues an extra real session for a seeded user; returns the raw token (the cookie value). */
    issue: async (userId: string) => (await application.services.auth.issueSession(userId)).token,
    close: () => app.close(),
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
