# Kaydet server — security

Scope: Kaydet **user** authentication, sessions, CSRF, login throttling, and the encrypted storage of **mail-account
credentials**. Nothing here talks to a mail provider or a database yet (see "Deferred").
Read together with `ARCHITECTURE.md` (layers, request lifecycle) and `.env.example` (every setting).

```
                  KAYDET USER  ── password (Argon2id hash) ──▶  authenticates
                       │
                       ▼
                    SESSION  ── secret in an HttpOnly cookie; only its SHA-256 fingerprint is stored server-side
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
        Account A              Account B          ← reachable only through AccountAccess (ownership)
            │                     │
            ▼                     ▼
   AES-256-GCM ciphertext   AES-256-GCM ciphertext ← decrypted only inside MailCredentialResolver, for a mail adapter
            └──────────┬──────────┘
                       ▼
                 Mail provider (future phase)
```

**Kaydet authentication ≠ mail-account authentication.** The Kaydet password is compared only with the Kaydet user's
hash. It is never used with, derived into, or stored beside a mail credential; mail credentials are never returned to
the browser; encryption keys are never derived from any password.

## 1. Authentication model

- A **Kaydet user** has `id`, a normalised `identifier`, an Argon2id `passwordHash`, `createdAt`, `updatedAt`.
- Sign-in is the Phase 2 contract `POST /session { identifier, password }` → the `Session` DTO
  (`authenticated`, `user.id`, `expiresAt`) and nothing else.
- **Identifier**: the contract leaves the format to this phase. Decision: a printable string without whitespace, control
  or bidi-format characters (typically an e-mail address), Unicode **NFKC**-normalised, trimmed and lower-cased, ≤ 320
  characters. Applied at user creation and at sign-in, so `Ali@Example.com` and `ali@example.com` are one user. No other
  identifier types exist.
- **No self-registration.** The contract has none. `UserAdministration.createUser` is an internal capability (used by tests;
  a command-line tool will call it). A fresh database has no users until the process owner creates them; users are now **durable** (`users` table).
- Login flow: `validate (contract) → throttle → find user → verify password (dummy hash if unknown) → NEW session → cookie`.
- Logout flow: `DELETE /session` → session **revoked server-side** → clearing cookie. Deleting the cookie alone is not logout.

## 2. Session model

`Session { id, userId, secretFingerprint, createdAt, expiresAt, lastSeenAt, revokedAt }`.

- The browser holds a 256-bit random **secret** (base64url). The server stores only `SHA-256(secret)` (the *fingerprint*)
  and looks sessions up by it — a leaked session store cannot be replayed as cookies. (A fast hash is correct here: the
  secret is high-entropy, so there is nothing to brute-force; a slow hash would only add cost per request.)
- Session ids and secrets are never in an API response, URL, log or DTO.
- **Validation** (every request with a cookie): session exists → not revoked → before `expiresAt` (absolute) → within the
  idle window since `lastSeenAt` → its user still exists. Any failure = one answer: `session_expired`.
- **Lifetimes** (centralised config; defaults): absolute **7 days** (`SESSION_ABSOLUTE_TTL_SECONDS`), idle **8 hours**
  (`SESSION_IDLE_TTL_SECONDS`). Activity slides the idle window but never the absolute one, so no session lives forever.
  `lastSeenAt` is written at most once per `SESSION_TOUCH_INTERVAL_SECONDS` (60 s), so idle expiry has ±1 min resolution.
- **Rotation / fixation**: every sign-in mints a brand-new secret server-side; a session the browser presented at sign-in is
  revoked. A cookie value chosen by an attacker never becomes an authenticated session (it is simply unknown).
  There are no anonymous sessions, so nothing pre-authentication exists to be fixated.
- **Revocation** (`AuthService.revokeAllForUser(userId, { exceptSessionId })`, `logout`): the hook for logout, password
  change, security reset, account removal, administrator action. No admin system exists.

## 3. Cookie policy

`Set-Cookie: kaydet_session=<secret>; Path=<API prefix>; HttpOnly; SameSite=Lax; Max-Age=<remaining>; Expires=…; [Secure]`

| Attribute | Value | Why |
|---|---|---|
| `HttpOnly` | always | JavaScript (and XSS) cannot read the session. |
| `Secure` | **always in production**; off in development/test (plain `http://localhost`) | never sent over HTTP in production. Not switchable in production. |
| `SameSite` | `Lax` (default) or `Strict` (`SESSION_COOKIE_SAMESITE`); **never `None`** | not sent on cross-site POSTs (a CSRF layer). Requires web and API on the **same site** (same registrable domain, e.g. `app.example.com` + `api.example.com`; `localhost:5173` + `localhost:3001` in development). |
| `Path` | the API prefix (`/api`) | the credential is not sent to anything else on the host. |
| `Domain` | not set (host-only) | not shared with sibling subdomains. |
| `Max-Age`/`Expires` | remaining absolute lifetime | bounded. |

No second, JavaScript-readable authentication token exists; nothing authentication-related is placed in the URL,
`localStorage`, `sessionStorage` or IndexedDB by the server. The web client will keep only the CSRF token (below) in memory.

## 4. Password hashing

**Argon2id** (RFC 9106) via the runtime's own `crypto.argon2` (Node ≥ 24.7 — declared in `engines`): memory-hard, salted,
no third-party dependency. All parameters live in **one** constant (`PASSWORD_HASH_PARAMS` in
`infrastructure/security/argon2-password-hasher.ts`): **46 MiB memory, 2 passes, 1 lane, 16-byte salt, 32-byte tag**
(≥ the OWASP minimum of 19 MiB / t=2 / p=1; ≈ 0.1 s per hash on a development machine). Application code depends on the
`PasswordHasher` port; tests use the **real** hasher (nothing is weakened for speed).

- Hashes are self-describing PHC strings, so raising the parameters later does not invalidate stored hashes; each hash is
  verified with its own parameters, **bounded** (≤ 256 MiB, ≤ 10 passes, ≤ 8 lanes) so a crafted record cannot demand
  unbounded memory. A malformed/unsupported hash verifies as `false`, never as an exception.
- Comparison is constant-time. Hashing runs on the libuv thread pool (does not block the event loop; four concurrent
  hashes by default — one more reason sign-in is throttled).
- No plaintext, no reversible encryption, no SHA-256/MD5, no custom algorithm. There is **no** "rehash on login" yet.

## 5. Password policy

For **new** passwords (user creation now, password change later): **10–256 characters** (`PASSWORD_MIN_LENGTH`,
`PASSWORD_MAX_LENGTH`; counted in code points), not blank. **No composition rules** (symbols/cases add friction, not
security — NIST SP 800-63B). Violations are field reasons (`too_short`, `too_long`, `blank`) that never echo the password.
At **sign-in** only the upper bound applies (a longer input is treated as a failed attempt without being hashed as-is):
an existing password is never rejected as "too weak". Deferred: breached-password screening.

## 6. Rate limiting / brute-force protection

`LoginRateLimiter` port; the adapter is still **in-memory** (Phase 5 did not persist it) — development / single-instance protection only; a restart forgets counters.

- Two independent keys: the normalised **identifier** (defends one account from many addresses) and the **client address**
  (defends against one source trying many accounts = credential stuffing).
- Temporary **exponential back-off**, never a permanent lock-out: after 5 failures per identifier (20 per address) each
  further failure locks the key for `30 s · 2ⁿ`, capped at 15 min; failures are forgotten after 15 minutes of quiet.
  All numbers are `LOGIN_*` settings.
- Order: throttle → verify. A blocked attempt is **neither verified nor counted** (no oracle while locked, no lock extension).
- Response: `429 rate_limited` + `Retry-After`. It depends only on the *key's* state, so it is identical for existing and
  non-existing identifiers. A success clears the identifier counter but **not** the address counter.
- Only sign-in is limited; authenticated traffic is not.
- **Limits:** state is per process (N instances = N counters; a restart forgets); the table is bounded, so an attacker flooding
  it with junk keys can shed old counters; behind a proxy `TRUST_PROXY=true` is required or every client shares one address.
  A distributed limiter implements the same port.

## 7. CSRF strategy

CORS is **not** a CSRF defence: it controls who may *read* a response, while a cross-site form or `no-cors` request can still
*send* one carrying the cookie. Three independent layers guard every state-changing request (`POST/PUT/PATCH/DELETE`):

1. `SameSite=Lax|Strict` cookie — not sent on cross-site POSTs by modern browsers.
2. **Origin check** (all state-changing requests, including sign-in): if the browser sent an `Origin` header it must be one of
   `CORS_ALLOWED_ORIGINS`, else `403 forbidden`. Browsers always send `Origin` on cross-origin state-changing requests.
3. **CSRF token** (state-changing requests of session routes): header `X-CSRF-Token` must equal
   `HMAC-SHA-256(sessionSecret, "kaydet:csrf:v1")`, compared in constant time; else `403 forbidden` with
   `fields: [{ field: "x-csrf-token", reason: "missing" | "invalid" }]`. The check runs **before the body is read**.

The token is a **separate value**, not the session secret: it cannot be reversed into it, holding it authenticates nothing, it
needs no extra server key, is stateless, and dies with the session (rotated at every sign-in). The SPA learns it from the
`X-CSRF-Token` **response header** of `POST /session` and `GET /session` (exposed to allowed origins by CORS; a page reload
re-reads it with `GET /session`) and keeps it **in memory** — no readable cookie, works with the API on a different origin
of the same site. Because the contract `Session` DTO is strict, the token cannot travel in the body.

Sign-in has no session yet, so it is protected by the Origin check (+ SameSite) only; *login CSRF* (forcing a victim into
an attacker's account) is a limited risk and is mitigated, not eliminated, by that. The web client is not yet wired to this;
its obligation is: send `X-CSRF-Token` on every mutation, refresh it after sign-in, drop it at sign-out.

## 8. Credential encryption

`CryptoPort` implemented by `AesGcmCrypto` — **AES-256-GCM** (AEAD, from the runtime; no custom cryptography). The algorithm,
version and payload format are centralised in that one file. One string envelope:

```
kaydet.v1.aes-256-gcm.<keyId>.<iv>.<ciphertext>.<authTag>       (last four parts base64url)
```

| Field | Purpose |
|---|---|
| `v1` | format version (the layout can evolve) |
| `aes-256-gcm` | algorithm named explicitly (another can coexist later) |
| `keyId` | which key encrypted it — enables rotation; never the key |
| `iv` | 96-bit random nonce, fresh for every encryption |
| `authTag` | 128-bit GCM tag: any change to ciphertext, iv, key id or context fails decryption |

- The **context** (`mail-credential:v1:<userId>:<accountId>`) is authenticated as AAD: a ciphertext copied to another account
  or user does not decrypt.
- Failure is always `decryption failed` — bad tag, unknown key, wrong context and malformed envelope are indistinguishable,
  and the credential-vault turns it into a generic `internal_error` whose cause never holds plaintext.
- What is encrypted: the whole credential (`username`, `password`, IMAP/SMTP endpoints) as one JSON blob — endpoints are
  private too. The envelope is stored in `CredentialRepository`; `replace()` swaps it in **one** step (atomic at the abstraction).
- The envelope is never sent to a browser: no DTO or event schema can carry it (`security-guards.test.ts` scans them all).

## 9. Key management

- Keys come from **configuration only** (`CREDENTIAL_ENCRYPTION_KEYS="id:base64key,…"`, 32 random bytes each,
  `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID`). Never hard-coded, never committed, never derived from a password.
- `ServerConfig` (what HTTP receives) contains **no** key material; keys live in `ServerSecrets`, read only by the
  composition root, and are passed to the `KeyProvider` behind `AesGcmCrypto`. A secret manager or KMS is another
  `KeyProvider`/`CryptoPort` — no application code changes.
- **Production refuses to start** without valid keys (config validation *and* a second check in the composition root).
  Outside production, if none is set, a **throw-away in-process key** is used with a startup warning (stored credentials die
  with the process — with the durable database this means a development database's credentials become unreadable after a restart, so set a real key
  for any database you keep); this path is unreachable in production.
- Configuration errors name the variable and key id, never key material. **Never log the configuration object.**

## 10. Key rotation

Prepared, not automatic. Procedure (per `CredentialVault`, tested):

1. Generate a new key; deploy with **both** keys and `CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID=<new>` — new writes use the new key,
   old records still decrypt.
2. `CredentialVault.keyIdOf(account)` reports which key encrypted a record (no decryption, no key exposure);
   `CredentialVault.reencrypt(account)` re-encrypts one record with the active key. A future maintenance command loops over accounts.
3. When no record reports the old id, remove the old key from configuration. (Removing it earlier makes those records unreadable.)

Not implemented: the maintenance command, scheduled rotation, and re-encryption of *all* records. One key safely covers ~2³² random-nonce
encryptions — orders of magnitude beyond credentials-per-account.

## 11. Credential access boundary

```
HTTP ──▶ use case ──▶ MailCredentialWriter.save/update/remove        (write-only: nothing returns a secret)
                         │
mail adapter (later) ──▶ MailCredentialResolver.withCredentialForMailAdapter(authorizedAccount, cb)
                         │        decrypt ─▶ cb(plaintext) ─▶ reference dropped
```

- No generic `getSecret()`. The resolver takes an **`AuthorizedAccount`** (proof of ownership) and passes plaintext to a callback;
  it is not cached, returned, logged, put in the request context, an event, a DTO or an error.
- HTTP receives only `useCases`. The application barrel does not export the vault, hasher, crypto or security ports, and the boundary
  guards (script + ESLint + tests) forbid HTTP from importing them; mail ports (`MailboxPort`, `MailSenderPort`) cannot mention credentials.
- JavaScript cannot zero a string: "smallest lifetime" = no retained references, not memory wiping.
- Account create/update encrypt through the writer; account delete removes the record; a failed encryption rolls the new account back.
  **Not done here:** verifying credentials against the provider (mail phase) — the contract's "verify before storing" arrives with the IMAP adapter.

## 12. Authorization / account scoping

Unchanged from Phase 3 and now backed by real sessions: `session → user → owned account → AuthorizedAccount → repository / mail port`.
`AccountAccess.authorize` looks up by `(userId, accountId)`; foreign and nonexistent accounts both answer `account_not_found` with an identical
body; the branded `AuthorizedAccount` cannot be forged, and account-scoped ports refuse raw ids at compile time. Tests cover every account-scoped
route for own / foreign / nonexistent / anonymous / expired / revoked (`authorization.test.ts`, `session-security.test.ts`).

## 13. Logging restrictions

Never logged: passwords, password hashes, session secrets, cookies, CSRF tokens, mail credentials, decrypted values, ciphertext, login
identifiers, query strings, request/response bodies or headers. Logged: request id, method, **route pattern**, status, duration, error
`code`/`kind`/`operation`, and `userId` on sign-in. The application layer has no logger at all. As a safety net pino redacts
`cookie`, `authorization`, `x-csrf-token`, `set-cookie` and `*.password|passwordHash|token|secret|credential|csrfToken`. Tests run full sign-in,
failure, CSRF, credential and logout flows at `trace` level and assert none of the above appears.

## 14. Threat model

| Threat | Current mitigation | Remaining limitation |
|---|---|---|
| **Credential stuffing** | per-address throttling with back-off; uniform failure; Argon2id makes each guess expensive | in-memory, per-process limiter; a botnet with many addresses is limited only per identifier; no breached-password screening, no MFA |
| **Brute-force login** | per-identifier throttling (temporary, exponential, capped); no free oracle while locked | an attacker can keep a *targeted* account in back-off (bounded to 15 min; never permanent) — an availability trade-off |
| **Session theft** | HttpOnly (no script access); Secure in production; SameSite; hashed at rest; 7 d absolute / 8 h idle; logout + revoke-all | a stolen cookie works until expiry/revocation (no device/IP binding); malware on the device wins; no "list my sessions" |
| **Session fixation** | secrets are minted server-side at every sign-in; presented session revoked; no anonymous sessions | — |
| **CSRF** | SameSite + Origin check + per-session token, all before body parsing; CORS kept separate | login CSRF only covered by Origin/SameSite; a same-site subdomain XSS could read the token (then the API); requires web & API on one site |
| **Account enumeration** | one `invalid_credentials` for unknown user/wrong password/unusable input; dummy-hash verification; identical throttle answer | timing is **reduced, not eliminated** (dummy vs real hash, DB lookup, oversize input short-cuts) — not constant-time end to end |
| **IDOR / account takeover** | ownership by `(userId, accountId)`; branded `AuthorizedAccount`; `account_not_found` for foreign ids; per-user namespaces | correctness depends on every new repository taking `AuthorizedAccount`/user (enforced by types + review + sweep tests) |
| **Credential leakage through logs** | no logging in application; route patterns only; redaction; tests at trace level | third-party log sinks/proxies, crash dumps and `err` causes from *future* adapters must be reviewed |
| **Credential leakage through API** | strict DTOs; write-only account fields; contract scan test; vault write-only for use cases | a future DTO must keep passing `security-guards.test.ts` |
| **Encryption-key compromise** | keys only from config/secret store, never in code/DB/config object; key ids + rotation procedure; production requires keys | key and data live in the same server process; a compromised host or env leaks both; no HSM/KMS yet; no automated rotation |
| **Ciphertext tampering** | AES-256-GCM tag; context AAD; generic failure | an attacker with DB write can *delete/replace* a credential (denial of service), not read or forge one |
| **Malicious/stolen session** | idle + absolute expiry; server-side revocation; revoke-all hook | no anomaly detection; no step-up authentication for sensitive actions |
| **Replay of revoked session** | revoked/expired/unknown all fail at lookup on every request; tested on every protected route | — |
| **Insecure development configuration** | Secure/keys/origins enforced in production; no auth bypass exists (`NODE_ENV` never disables a check); ephemeral key impossible in production | development runs over HTTP without `Secure`; an operator can still set `NODE_ENV=development` in production — deployments must set `NODE_ENV=production` |

The system is **not** claimed to be perfectly secure. Also unaddressed: SSRF through user-supplied IMAP/SMTP hosts (Phase 6 must restrict
targets), denial of service beyond sign-in throttling and body limits, general API rate limiting, TLS termination (deployment), dependency
supply-chain review.

## 15. Deferred security work

MFA/step-up authentication · password change/reset flows (rule: new hash → **revoke all sessions** → fresh sign-in) · breached-password checks ·
distributed rate limiting · general API rate limiting · session list/"log out everywhere" UI · audit log · KMS/secret-manager `KeyProvider` and
automated key rotation · rehash-on-login when parameters change · provider-credential verification and SSRF policy for IMAP/SMTP hosts ·
CSP for the web client (this server's CSP is `default-src 'none'`, which suits an API) · HTML sanitiser (Phase 2 decision D2, server-phase work) ·
**the transaction requirements listed below were implemented in Phase 5** (`DATABASE.md` §8).

**Atomicity — implemented in Phase 5 with `UnitOfWork` over SQLite transactions:** *login* — new session insert + revocation of the presented session in one transaction ·
*logout/revoke-all* — the revocation update(s) in one transaction · *credential update* — account metadata + encrypted credential replacement in
one transaction · *account create* — metadata + credential insert together · *account delete* — metadata + credential
delete together · *future password change* — password-hash replacement + revocation of all other sessions in one transaction, then require fresh sign-in.
User uniqueness is a unique index on the normalised identifier. **Not yet wired:** a password-change flow (the rule and the `updatePasswordHash` + `revokeAllForUser` building blocks exist, in one unit of work once the flow does).

## 16. Production requirements

1. `NODE_ENV=production` (enables `Secure` cookies, HSTS, requires the settings below).
2. `CREDENTIAL_ENCRYPTION_KEYS` (+ `…_ACTIVE_KEY_ID`) from a secret store — otherwise the server refuses to start. Back the keys up separately from the data.
3. `CORS_ALLOWED_ORIGINS` = the exact `https://` origin(s) of the web client (also the CSRF origin allow-list).
4. Serve over **HTTPS** (TLS terminated by a proxy/platform); set `TRUST_PROXY=true` only behind one you control, otherwise throttling sees one address.
5. Web and API on the **same site** (SameSite cookie).
6. Run **one instance per database file** (the login limiter and the SQLite transaction gate are per-process). Set `DATABASE_PATH` (absolute, persistent, local disk) — production refuses to start without it —
   and follow the backup/restore rules in `DATABASE.md` §14. The database holds **ciphertext for credentials** but **plaintext mail metadata and bodies**: put it on an encrypted volume and protect backups like the database.
7. Node ≥ 24.7 (`crypto.argon2`).
8. Never log or expose the environment/configuration object; keep `LOG_LEVEL` at `info` or above.
