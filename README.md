# Kaydet Web Client

Web version of the Kaydet mail client. The Flutter app at `C:\Project\Kaydet` is the source of truth
for behavior, terminology and design; see `CLAUDE.md` for the permanent project rules.

## Layout

```
apps/web          React + Vite + TypeScript (application shell, design system, mail list)
packages/domain   Pure TypeScript domain rules + the browser-safe API contract (Zod), shared by web and server
apps/server       Fastify backend foundation: HTTP → application → ports ← infrastructure (see apps/server/ARCHITECTURE.md)
packages/tokens   Design tokens (single source of truth) → generated CSS custom properties
scripts/          Repo guards (no raw colors outside packages/tokens; architecture boundaries)
```

## Commands

```bash
npm install
npm run dev         # web client, http://localhost:5173  (regenerates tokens.css first)
npm run dev:server  # backend foundation, http://127.0.0.1:3001  (config: apps/server/.env.example)
npm run typecheck
npm run lint        # ESLint (a11y, hooks, mock isolation, package boundaries) + raw-color + boundary guards
npm test            # Vitest: tokens + domain + web + server
npm run build       # web + server
```

## Status: domain + API contract phase

`packages/domain` holds the ported mobile business rules (see `packages/domain/PORTING.md`: source, purpose
and web usage of every rule) and the API contract: DTO schemas, query/action/error/event schemas and the route
table (`src/api`). It is the single source of truth between browser and server — never re-declare a DTO in an app.

The UI is built against the `MailDataSource` port (`apps/web/src/data/types.ts`), whose data types are the
contract's DTOs. Everything behind it is still a **mock** (`apps/web/src/data/mock`, wired only in
`app/providers.tsx`); it derives folder trees, filtering/sorting and action outcomes from `@kaydet/domain`, and
is replaced by an API-backed source later. Dev scenarios: `?mock=loading`, `?mock=empty`, `?mock=error`.

Boundaries (enforced by ESLint + `npm run check:boundaries`): the domain package imports nothing but `zod`; the
web app never imports IMAP/SMTP/database/server code; `apps/server` may use the domain but never the web app, and its own
layers point one way (HTTP never imports infrastructure; the application layer never imports HTTP or Fastify).

## Status: backend (foundation, security, persistence)

`apps/server` is the backend: validated configuration, request context, use cases behind ports, centralized contract errors,
structured logging, health/readiness and graceful shutdown (Phase 3), plus **real Kaydet authentication and credential security**
(Phase 4): Argon2id passwords, hashed server-side sessions in an HttpOnly cookie, CSRF protection, login throttling, account
ownership checks, and AES-256-GCM encryption of mail-account credentials with versioned keys. Phase 5 added **durable SQLite
persistence** (`node:sqlite`, WAL, migrations, transactions, FTS5 search index) behind the same repository ports. **IMAP/SMTP, mail
sync, the outbox worker, SSE and attachment blob storage are deferred**, and the web client is not connected to the server yet (it
still uses the mock data source). Architecture and lifecycles: `apps/server/ARCHITECTURE.md`; security model, threat model and
production requirements: `apps/server/SECURITY.md`; schema, migrations, transactions, backup: `apps/server/DATABASE.md`.

Design tokens live in `packages/tokens/src/tokens.ts` (mobile-confirmed values); `tokens.css` is
generated — run `npm run tokens` after editing. Font: Satoshi (official Fontshare WOFF2, unmodified,
ITF FFL v2.0 — see `apps/web/public/fonts/`).
