# Kaydet server — backend architecture (Phase 3 foundation · Phase 4 security · Phase 5 persistence)

`apps/server` is the backend of Kaydet Web. **Phase 3** built the foundation: HTTP transport, validated configuration,
request context, application use cases, ports, in-memory adapters, error handling and observability. **Phase 4** added
real Kaydet user authentication (Argon2id, server-side hashed sessions, HttpOnly cookie), CSRF protection, login
throttling and encrypted storage of mail-account credentials (AES-256-GCM, versioned keys) — all behind ports. **Phase 5**
replaced the in-memory repositories with **SQLite** behind those same ports (durable users, sessions, accounts, encrypted credentials,
folders, messages, drafts, outbox, labels, signatures, templates, a migration system, FTS5 search index, and a transaction boundary)
without touching a use case, so IMAP/SMTP and SSE can be added later without restructuring the server. The security model, cookie policy,
threat model and production requirements are in **`SECURITY.md`**; the schema, PRAGMAs, migrations, transactions and backup rules are in **`DATABASE.md`**. The API contract is `packages/domain/src/api` (Phase 2) and is not
redeclared here.

```
Browser
   ↓   HTTP + JSON (contract)
HTTP            src/http/             Fastify routes, plugins, serializers. Transport only.
   ↓
Application     src/application/      use cases, RequestContext, AccountAccess, pagination, errors
   ↓
Ports           src/application/ports/  repositories, mailbox, sender, blobs, events, clock, ids  ·  security/: password hasher,
   ↑ implemented by                                 session secrets, login limiter, mail-credential writer/resolver  ·  crypto
Infrastructure  src/infrastructure/   sqlite/ (repositories, migrations, transactions) · memory/ (test doubles) · event bus · Argon2id ·
                                          AES-256-GCM + key providers · session secrets
```

```
Browser
   ↓   HTTP + JSON (contract)
HTTP                 src/http/                  transport only — cannot see SQL, a database handle, keys or provider identity
   ↓
Application          src/application/           use cases; `transactions.run(…)` marks what must be atomic
   ↓
Repository ports     src/application/ports/     UserRepository, SessionRepository, AccountRepository, FolderRepository, MessageRepository,
   ↑ implemented by                             DraftRepository, OutboxRepository, LabelRepository, SignatureRepository, TemplateRepository,
   │                                            CredentialRepository, UnitOfWork  (+ MailStoreWriter: provider identity, not in the barrel)
SQLite adapters      src/infrastructure/sqlite/ the ONLY code that imports the driver (`node:sqlite`)
   ↓
SQLite database      one file, WAL, foreign keys ON
```

```
Browser  ✗  IMAP        The browser never talks to IMAP, SMTP or SQLite.
Browser  ✗  SMTP        It sees only the contract DTOs; protocol concepts (UID, UIDVALIDITY, MODSEQ, paths,
Browser  ✗  SQLite      flags, credentials) cannot be expressed in them — every schema is strict.
```

## Source tree

```
apps/server/
├── package.json  tsconfig.json  vitest.config.ts  .env.example  ARCHITECTURE.md  SECURITY.md
├── scripts/build.mjs                    production bundle (esbuild; inlines @kaydet/domain)
└── src/
    ├── main.ts            process entry: reads process.env ONCE, starts, wires SIGINT/SIGTERM
    ├── server.ts          listen + graceful shutdown
    ├── app.ts             buildApp(deps): Fastify + plugins + contract routes (no infrastructure imports)
    ├── compose.ts         COMPOSITION ROOT: config + secrets → adapters → ports → use cases + services
    ├── config/            env.ts (parse) · config.ts (validate/derive, secrets split) · config.types.ts
    ├── http/
    │   ├── route-registry.ts        binds handlers to the contract route table, validates in/out
    │   ├── routes/*.routes.ts       one module per resource (+ health)
    │   ├── plugins/                 error-handler · request-context · security (CORS+headers) · validation
    │   ├── middleware/              auth-context (cookie → RequestContext, session guard, Set-Cookie) · csrf (origin + token guards)
    │   └── serializers/attachment.ts    safe download headers
    ├── application/
    │   ├── use-cases/               session · accounts · folders · messages · drafts · attachments · search · …
    │   ├── services/                account-access (authorization) · auth-service (login/sessions) · credential-vault ·
    │   │                            user-administration · identifier · password-policy
    │   ├── context/                 RequestContext, AuthorizedAccount
    │   ├── ports/                   repositories · mail · storage · events · clock · ids · security/ · crypto/
    │   ├── pagination.ts  errors.ts  index.ts
    ├── infrastructure/              sqlite/ (database · migrator · migrations/ · repositories · mail-store · unit-of-work) · memory/ · events/ · clock/ · ids/ · mail/ · security/ (Argon2id, session secrets) · crypto/ (AES-GCM, key providers)
    └── testing/                     harness + fixtures (tests only)
```

## Dependency direction (enforced)

`http → application ← infrastructure`; `compose.ts` is the only place that names implementations; `app.ts` builds
HTTP from injected dependencies and never imports infrastructure. `@kaydet/domain` is consumed by every layer through
its root entry.

Enforced twice, and the enforcement itself is tested (`src/architecture.test.ts` feeds both guards deliberately bad
code and asserts they fail):

| Rule | ESLint (`eslint.config.js`) | `scripts/check-boundaries.mjs` |
|---|---|---|
| server never imports web | ✔ | ✔ (packages, relative paths, manifest) |
| domain never imports server / Node / Fastify | ✔ | ✔ |
| web never imports server or protocol/database libraries | ✔ | ✔ |
| HTTP never imports infrastructure | ✔ | ✔ |
| application never imports HTTP, infrastructure, Fastify, protocol libs or Node built-ins | ✔ | ✔ |
| infrastructure never imports HTTP | ✔ | ✔ |
| config never imports http/application/infrastructure | – | ✔ |
| `app.ts` never imports infrastructure | – | ✔ |
| HTTP reaches the application only through `application/index.ts` (no ports, services, vault, hasher, keys) | ✔ | ✔ |
| the `application/index.ts` barrel never exports security ports, crypto, the vault, hashing, user administration | – | ✔ |
| mail ports never import credential/security/crypto types | ✔ | ✔ |
| the application layer never reads `process.env` or imports crypto/Node built-ins | ✔ | ✔ (+ `security-guards.test.ts`) |

Tests and `src/testing/` are exempt: they compose real adapters on purpose.

## Composition root (`compose.ts`)

Reads the validated `ServerConfig` **and the separate `ServerSecrets`** (key material — HTTP never receives it),
constructs the adapters, and builds the application: `createApplication(ports, policy)` returns
`useCases` (what HTTP calls) and `services` (internal capabilities: user administration, the auth service, the credential
vault/resolver — never handed to HTTP). Routes and use cases never instantiate anything. `compose(config, { secrets, ports })`
lets a test replace any single port.

Current wiring (`openPersistence` opens SQLite when `DATABASE_PATH` is configured — always in development and production):

| Port | Adapter | Behaviour |
|---|---|---|
| users, sessions, accounts, credential records, folders, messages, drafts, outbox, labels, signatures, templates, **transactions** | **SQLite** (`infrastructure/sqlite`) | durable; WAL; atomic `UnitOfWork`; migrations run at startup (`DATABASE.md`) |
| the same ports in tests (no `DATABASE_PATH`) | in-memory (`infrastructure/memory`) | fast application-level test doubles; `MemoryUnitOfWork` does not roll back |
| attachment bytes (`BlobStorage`) | in-memory placeholder | blob storage is a later phase; attachment **metadata** is durable |
| `PasswordHasher` | `Argon2PasswordHasher` | Argon2id, 46 MiB / 2 passes, parameters in one constant |
| `SessionSecrets` | `NodeSessionSecrets` | 256-bit secret, SHA-256 fingerprint, HMAC CSRF token |
| `LoginRateLimiter` | `MemoryLoginRateLimiter` | per identifier + per address, exponential back-off; single instance |
| `CryptoPort` | `AesGcmCrypto` over a `KeyProvider` | AES-256-GCM, key id in the envelope; keys from configuration (throw-away key outside production if unset) |
| `MailboxPort` | `UnavailableMailbox` | provider operations → `service_unavailable` |
| `EventBus` | `InMemoryEventBus` | in-process fan-out |
| `Clock`, `IdGenerator` | system clock, UUID | |

`MailSenderPort` and `BlobStorage` are defined; nothing calls the sender yet (the future outbox worker will).

## Request lifecycle

```
socket → Fastify
  1. onRequest  CORS (answers preflights)                → allowed origins only (who may READ responses)
  2. onRequest  shutdown gate                            → 503 while closing
  3. onRequest  origin guard  (CSRF layer 1)             → 403 for a state-changing request from a foreign Origin
  4. onRequest  request id + RequestContext              → cookie → useCases.resolveSession → actor/session (+ CSRF token)
  5. onRequest  (route) session guard                    → 401 not_authenticated / session_expired  (anonymous routes are the
                                                           two the contract marks `auth: 'none'`)
  6. onRequest  (route) CSRF token guard (layer 2)       → 403 forbidden for state-changing methods, before the body is read
  7. body parse (size limit per route; JSON)             → 400 / 413 / 415
  8. validate params, query, body with the contract's Zod schemas → 400 invalid_request (+ field list)
  9. handler = ONE use case call                         → AccountAccess → repositories / mailbox / events
 10. validate the result against the contract response schema (dev/test; off by default in production)
 11. send with the contract's success status
  onSend    security headers, X-Request-Id
  onResponse  one access-log line: requestId · method · route pattern · status · duration
```

Routes contain no business logic and no error formatting.

## Error lifecycle

```
throw AppError(code, extras)  ──┐   expected failure: a contract ApiErrorCode
throw anything else           ──┼──▶ defineUseCase(): adds the operation name; unknown errors → AppError('internal_error', cause)
transport error (bad JSON…)   ──┤
unknown route                 ──┘
                                 ▼
              http/plugins/error-handler.ts  (the only place errors become responses)
                                 ▼
   { "error": ApiError }   status from ERROR_DEFINITIONS · user-safe Turkish message · requestId · retryable
                                 +  one log line: requestId · code · kind · status · operation (+ cause for 5xx)
```

`ApiError` has no free-text field, so provider text, SQL, stack traces and credentials **cannot** be serialised; they
are logged server-side only. The nine contract kinds (validation, authentication, authorization, not_found, conflict,
network, provider, sync_temporary, operation_permanent) come from the domain's `ERROR_DEFINITIONS`.
Two transport cases have no dedicated contract code: unknown routes answer `invalid_request` with HTTP 404, and
oversize/unsupported bodies answer `invalid_request` with 413/415.

## Authentication and credential security (Phase 4)

Kaydet authentication and mail-account authentication are separate systems. Details and threat model: `SECURITY.md`.

```
Kaydet user ─▶ password ─▶ AuthService.login ─▶ session (server: fingerprint + metadata; browser: HttpOnly cookie secret)
                                                   │
       RequestContext { requestId; actor: anonymous | { userId };            ◀── every request: cookie → resolveSession
                        session: none | expired | active{id, expiresAt, csrfToken}; metadata }
                                                   │
                     AccountAccess.authorize ─▶ AuthorizedAccount ─▶ repositories / mail ports
                                                   │
                     MailCredentialWriter (use cases: save/update/remove — write-only)
                     MailCredentialResolver (mail adapters only: decrypt inside a callback)
```

**Login** (`AuthService.login`): normalise identifier → `LoginRateLimiter.check` (blocked ⇒ `rate_limited`, nothing verified) →
find user → `PasswordHasher.verify` (against a real dummy hash when the user is unknown) → on failure count it and answer the one
`invalid_credentials`; on success clear the identifier counter, **revoke the presented session**, mint a new secret, store its
fingerprint → HTTP sets the cookie and `X-CSRF-Token`. **Logout**: revoke server-side, then clear the cookie.
**Resolve** (each request): fingerprint → session → not revoked → not past `expiresAt` → not idle → user exists → optionally touch
`lastSeenAt`. Expired, idle, revoked and unknown all answer `session_expired`. `RevokeAllForUser` is the hook for future
password change / reset / account removal.

**Credentials**: `createAccount`/`updateAccount` → `MailCredentialWriter` → `CredentialVault` serialises → `CryptoPort.encrypt`
(AES-256-GCM, envelope `kaydet.v1.aes-256-gcm.<keyId>.<iv>.<ciphertext>.<tag>`, context `mail-credential:v1:<user>:<account>`) →
`CredentialRepository.replace` (one step). Only `MailCredentialResolver.withCredentialForMailAdapter(authorizedAccount, cb)` decrypts,
and only for the duration of `cb`. The vault, hasher, crypto and security ports are **not exported by `application/index.ts`**, the
barrel HTTP imports.

There is no global "current user": every use case receives the `RequestContext` explicitly. Users are created only through
`services.users.createUser` (no self-registration in the contract).

## Authorization / account scope

```
session → user → owned account → AuthorizedAccount → repository / mail port
```

`AccountAccess.authorize(ctx, accountId)` looks the account up **by (userId, accountId)**. A foreign account and a
nonexistent one are indistinguishable: both `account_not_found` (never `forbidden`), same body. The result is an
`AuthorizedAccount` — a branded type whose constructor is not exported — and **every account-scoped port method takes
one instead of a string id**, so `request → accountId → repository` does not type-check (asserted with
`@ts-expect-error` in the tests). Ids without an account in the path (message, draft, outbox, template) are looked up
per user in the repository. Tests cover: anonymous, expired, valid account, another user's account, nonexistent
account, and a sweep over every account-scoped route.

## Ports

Only what the use cases need. Repository methods express use cases, not tables.

- **Repositories:** `AccountRepository`, `FolderRepository`, `MessageRepository` (read model, list + search + locate),
  `DraftRepository`, `OutboxRepository`, `LabelRepository`, `SignatureRepository`, `TemplateRepository`, plus (Phase 4)
  `UserRepository`, `SessionRepository` (fingerprints only) and `CredentialRepository` (opaque ciphertext, `replace` = one
  step). The SQLite adapters implement them without any change to a use case. **Provider identity** (UID, UIDVALIDITY, MODSEQ, Message-ID,
  mailbox path) lives behind the separate `MailStoreWriter` port — kept out of the application barrel HTTP imports — and never in a read repository's
  return type. **`UnitOfWork.run(fn)`** is the transaction boundary: the use case decides what is atomic; repositories do not open transactions that
  would prevent composition (multi-row repository writes join an outer transaction).
- **`MailboxPort`** (IMAP side): `requestSync`, folder create/update/delete, `applyActions`, `undo`. Speaks contract
  types and application ids; the adapter owns UIDs, UIDVALIDITY, MODSEQ, paths and flags. Failures are `AppError`s with
  provider/sync codes. **`MailSenderPort`** (SMTP side): `send(draft)`; used by the future outbox processor only.
- **`BlobStorage`:** `put` (validates size while streaming), `open`, `remove`, keyed by opaque strings whose segments
  are URL-encoded. Local disk, object storage or an encrypted store can implement it unchanged.
- **Security ports** (`ports/security`, `ports/crypto`; *not* in the barrel HTTP imports): `PasswordHasher`
  (`hash`/`verify`), `SessionSecrets` (`generate`, `fingerprint`, `csrfToken`, constant-time `equals`), `LoginRateLimiter`
  (`check`/`recordFailure`/`recordSuccess`), `MailCredentialWriter` (use cases) and `MailCredentialResolver` (mail adapters)
  — deliberately two narrow interfaces, no generic `getSecret()`.
- **`CryptoPort`:** `encrypt/decrypt(plaintext, context)` with authenticated context, `inspect(envelope)` (key id/version
  without decrypting) and `activeKeyId`. Production adapter `AesGcmCrypto` (AES-256-GCM) over a `KeyProvider`
  (configuration today; a secret manager or KMS later). Its envelope and key rules: `SECURITY.md` §8–10.
- **`EventBus`:** `publish(userId, MailEvent)`, `subscribe`, `close`. Events are the Phase 2 contract events
  (invalidation hints, no message content), addressed to a user. Mapping: MessageChanged → `messages.changed`,
  FolderChanged → `folders.changed`, AccountSyncChanged → `sync.status`/`accounts.changed`, OutboxChanged →
  `outbox.changed`. SSE is not implemented; the bus and the publishers are.
- **`Clock`:** `now()`. Used for undo-send windows and draft timestamps; tests inject a fake.

## Pagination

Contract cursors only. A repository speaks in an opaque `position`; `application/pagination.ts` wraps it in a cursor
bound to (account, scope, filter, sort) or to the search parameters — a cursor replayed against another query is
`invalid_cursor`. The cursor is not signed yet (a repository must validate the position it gets); signing arrives with
the auth phase's secrets. IMAP identifiers never appear in a cursor.

## Configuration

`config/env.ts` parses raw strings, `config/config.ts` validates and derives, `main.ts` is the only reader of
`process.env`. See `.env.example` (safe placeholders, no secrets). Highlights: `NODE_ENV`, `HOST` (default loopback),
`PORT`, `API_PREFIX`, `LOG_LEVEL`, `CORS_ALLOWED_ORIGINS` (exact origins, never `*`; development defaults to the local
Vite client, **production requires https origins**; the same list is the CSRF origin allow-list), session cookie and
lifetimes (`SESSION_*`), password limits, login throttling (`LOGIN_*`), credential-encryption keys, body/upload limits
(upload defaults come from the domain contract), `TRUST_PROXY`, `SHUTDOWN_TIMEOUT_MS`. Invalid configuration fails at startup
and names the variable, never its value. Secrets are split into `ServerSecrets` (composition root only); production without
valid `CREDENTIAL_ENCRYPTION_KEYS` refuses to start.

## Security baseline

Explicit CORS · hardening headers (`nosniff`, `X-Frame-Options: DENY`, `no-referrer`, `default-src 'none'` CSP,
`no-store`, HSTS in production) · per-route body limits · strict contract validation of params/query/body ·
request ids · no raw internal errors (production or otherwise) · credentials/tokens/query strings/route parameters
never logged (the access log records the route *pattern*) · attachment downloads served with `nosniff`, inline only for
passive types, HTML/SVG/XML/executables forced to download as `application/octet-stream`, file names sanitised ·
account-ownership boundary as above · Phase 4: Argon2id passwords, hashed server-side sessions in an HttpOnly cookie, CSRF (SameSite + Origin + per-session token), login throttling, AES-256-GCM credential encryption with versioned keys — see `SECURITY.md`.

## Idempotency (documented, not implemented)

Browser retries and flaky networks must never duplicate side effects. Operations that will need an idempotency
mechanism (key or natural id) when they gain real infrastructure:

- **send draft** — must not send twice. The contract already gives it a natural key: the draft id; `sendDraft` refuses a
  draft with a queued/sent outbox operation (`draft_already_sent`).
- **save draft** — `PUT /drafts/:draftId` is an idempotent upsert with a client-generated id.
- **message actions** — repeating flag/move/delete must converge; `undo` tokens are single-use.
- **attachment upload** — one file per request; a retry must not create a second attachment.
- **account creation** — `account_exists` (email per user) is the natural conflict.

No generic idempotency-key system exists; it will be designed with the durable outbox, not before.

## Transaction boundary (documented, not implemented)

Multi-step effects live in use cases, never in routes (`route → use case → repositories/mail/events`), so a future
unit-of-work can wrap a use case. Ordering rule already followed: events are published **after** the change succeeded.

## Testing strategy

Vitest, no network or real IMAP/SMTP. `src/testing/harness.ts` builds the real app over in-memory adapters, a fake clock and a
recording event bus (`app.inject`, no sockets); `src/testing/sqlite.ts` does the same over a **real SQLite file** written through the ports (with
real restarts: close, reopen, new composition). `server.test.ts` and `sqlite-lifecycle.test.ts` use real sockets and files.

| Suite | Covers |
|---|---|
| `config/config.test.ts` | valid/invalid environment, safe defaults, production rules, session/password/throttle/key settings |
| `http/http.test.ts` | health, request ids, validation, unknown routes, error mapping, response validation, headers/CORS, logging |
| `http/authorization.test.ts` | anonymous, idle-expired, valid/foreign/nonexistent account (all account-scoped routes), per-user namespaces |
| `http/session-security.test.ts` | sign-in/out over HTTP, cookie attributes, rotation, revoked/expired on every route, throttling, CSRF + CORS + malicious origin, credentials never in responses/events/logs |
| `application/auth-service.test.ts` | login, throttling, timing/enumeration, session validation (absolute, idle, revoked), revocation, password policy |
| `application/credential-vault.test.ts` | encrypted at rest, write-only use cases, resolver boundary, tampering, key rotation, account update/delete |
| `infrastructure/security.test.ts` | Argon2id, session secrets, AES-256-GCM (wrong key, tampered tag/iv/ciphertext, versions), rate limiter |
| `security-guards.test.ts` | credentials cannot appear in any response/event schema; HTTP cannot reach keys/hashing/decryption; application has no env/crypto/logging |
| `http/contract.test.ts` | responses parse with the domain schemas, strict request validation, every error code, attachments |
| `application/*.test.ts` | use cases against ports, failures, event publication, pagination |
| `infrastructure/sqlite/database.test.ts` | PRAGMAs read back (WAL, FKs, busy timeout), identity check, transactions (commit, rollback, isolation, serialisation), BUSY mapping, migrations (fresh, rerun, tamper, newer DB, failure) |
| `infrastructure/sqlite/repositories.test.ts` | users, sessions, accounts (ownership, cascade wipe), encrypted credentials (no plaintext in file/WAL), folders/tree, labels, signatures, templates, drafts, outbox |
| `infrastructure/sqlite/mail-store.test.ts` | message round trips, recipients order, provider-identity separation, domain-parity pagination + stability, attachment metadata, FTS consistency and Turkish folding, atomic batches |
| `infrastructure/sqlite/performance.test.ts` | 6,000 messages / 300 folders / 200 labels: `EXPLAIN QUERY PLAN` index checks and measured timings |
| `http/sqlite-integration.test.ts` | **restart persistence**, Phase 4 security on SQLite, contract responses from stored data, no SQLite leakage, use-case transactions, concurrency |
| `sqlite-lifecycle.test.ts` | startup order, fail-closed migrations, foreign/garbage files, production location rules, WAL cleanup on shutdown |
| `infrastructure/infrastructure.test.ts` | event bus, blob limit, unavailable mailbox |
| `server.test.ts` | listen, graceful shutdown with in-flight requests, shutdown timeout |
| `architecture.test.ts` | the boundary script and ESLint rules fail on deliberate violations |

## Deferred (NOT implemented yet)

IMAP, SMTP, mail synchronisation, the durable outbox **worker** (the outbox rows are stored), attachment blob storage and the streaming upload,
the HTML sanitiser, SSE/WebSocket, search *behaviour* beyond the index and query (Phase 11: attachment/contact search, highlighting, ranking), verifying mail credentials
against a provider, MFA and password change/reset, distributed rate limiting, connecting the web client to this server (the web client
still runs on its mock data source).

Deferred routes are registered and answer honestly: `POST /drafts/:id/attachments` → ownership check, then `service_unavailable` (the
upload body is not read and the connection is closed); `GET /events` → `service_unavailable`; provider-backed operations
(`sync`, folder changes, message actions) → `service_unavailable` through `UnavailableMailbox`.
