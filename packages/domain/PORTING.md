# @kaydet/domain — porting map

Pure TypeScript (no React, DOM/Node APIs, IMAP/SMTP/SQLite, Fastify) shared by `apps/web` and the future
`apps/server`. Runtime dependency: `zod` only. Mobile (`C:\Projects\KAYDET`, read-only) is the source of truth.

Every ported rule carries the same three facts in the header comment of its file: **SOURCE**, **PURPOSE**,
**WEB USAGE**. This table is the index.

## Ported rules

| Module (`src/…`) | SOURCE (mobile) | PURPOSE | WEB USAGE |
|---|---|---|---|
| `turkish/turkish.ts` — `trLower`, `trUpper` | `lib/core/turkish.dart` | Turkish I/İ/i/ı casing; default JS/Dart casing is wrong for Turkish | sorting, avatars, folder-name comparison |
| `turkish/turkish.ts` — `foldForSearch` | `lib/core/turkish.dart` | one normal form for search index **and** query | server search, threading keys, folder-name matching |
| `turkish/turkish.ts` — `normalizeSubject` | `lib/core/turkish.dart` (tests `turkish_test.dart`) | strip `Re:`/`Yanıt:`/`İlt:`/`Re[2]:` prefixes, fold-based (`İlt:` matches) | threading fallback key |
| `turkish/turkish.ts` — `displayNameFromEmail`, `avatarInitial` | `lib/core/turkish.dart` | name from address (`info`→`İnfo`), avatar letter | list rows, avatars |
| `address/address.ts` | `mail_models.dart` → `EmailAddress` | display/format/parse of `Ad <a@b>` lists (quote names with `, ; " < >`), syntactic validation, case-insensitive equality, `domainOf` | compose recipients, reply prefill, server validation |
| `address/avatar.ts` | `lib/core/avatar.dart` | FNV-1a sender tone; free-mail domains get no brand logo | `Avatar` component |
| `dates/dates.ts` | `lib/core/date_format.dart` | deterministic Turkish list/detail/group/relative dates, DST-proof day buckets | list rows, group headers, reader |
| `attachment/attachment.ts` | `attachment_type.dart`, `share_attachment_policy.dart`, `date_format.dart` (`formatBytes`) | attachment kind (extension beats MIME; CSV = spreadsheet; HTML/SVG = raw text, never rendered; executables blocked), 25 MB / 50 MB limits, blocked-extension list, Turkish messages, `1,5 MB` | chips/icons/preview routing; **server enforces the same on upload** |
| `folder/roles.ts` | `folder_mapping.dart` (+ Drafts rule from `message_actions.dart`) | server folder → role (SPECIAL-USE flag wins, then EN/TR names), sort order, Turkish display names, system-folder protection, delete permanence | folder sync (server), sidebar |
| `folder/tree.ts` | `folder_mapping.dart` → `buildFolderTree` (tests `folder_tree_test.dart`) | depth-first tree; system folders always roots; per-account paths; hidden containers keep the subtree | server builds `FolderDTO.depth/parentId`; mock fixture |
| `folder/rules.ts` | `folder_repository.dart`, `mail_connection.dart` (`childPath`) | create/rename/move/delete preconditions as pure planners | folder endpoints (server) |
| `threading/threading.ts` | `threading.dart` (tests `threading_test.dart`) | References/In-Reply-To first, subject fallback, subject-less mail stays alone; `buildReferences` (dedupe, cap 20) | sync (server), reply headers |
| `message/text.ts` | `text_extraction.dart` (tests `text_hardening_test.dart`) | linear-time HTML→text, entity decode without double decoding, list preview (skips quotes/signature), quote block, dark-scheme query pinning, meta-refresh / viewport-meta stripping | preview generation (server), reply quoting, pre-sanitiser preprocessing |
| `message/filter.ts` | `lib/app/providers.dart` → `MessageFilter`, `MessageSort` | independent toggles, 4 sorts, code-unit (not locale) comparison of Turkish-lowered text | list pages (server), filter UI |
| `labels/keywords.ts` | `label_keywords.dart` | label name → `kaydet_…` server keyword, unique per account; **must stay identical to mobile** so labels round-trip | server only |
| `search/search.ts` | `app_database.dart` (`buildFtsQuery`, `_messageFilterSql`), `search_filters.dart` | tokenisation, filter semantics (Trash excluded unless asked, role/name folder scope, `\Deleted` hidden), filter count badge | `GET /search` (server), search UI |
| `draft/compose.ts` | `compose_screen.dart` (`_applyReply`, `_prefixSubject`), `threading.dart`, `_markSourceMessage` | reply / reply-all (drop me + sender) / forward prefill, `Yanıt:`/`İlet:` prefixing, reply headers, answered/forwarded marking | compose prefill; server builds outgoing headers |
| `draft/send.ts` | `compose_screen.dart` (`_send`), `attachment_reminder.dart` (tests `attachment_reminder_test.dart`), `sendUndoWindowProvider` | blocking checks (To required, all addresses valid), then confirmations (forgotten attachment, empty subject), 5 s undo-send | compose "Gönder"; server repeats blocking checks |
| `actions/swipe.ts` | `swipe_action_resolver.dart`, `app_settings.dart` (`SwipeAction`) | one-tap action depends on folder + message state; drafts only delete | hover quick actions, shortcuts |
| `actions/rules.ts` | `mail_repository.dart` (`deleteMessages`), `message_actions.dart` | delete = Trash move (undoable) vs permanent (Trash/Junk/Drafts), undo window 6 s / toast 5 s | delete flow + confirm dialog; server enforcement |
| `actions/effects.ts` | local effects of `MailRepository` methods | predicted outcome of an action list → optimistic UI + a spec for server handlers | data layer (mock now, API client later) |
| `api/*` | DTOs from `tables.dart`/`mail_models.dart` (fields only), errors from `result.dart` | the browser-safe contract: DTO schemas, queries, actions, errors, events, route table | single source of truth for web ↔ server |

### Deliberate deviations from mobile (each is documented at the code)

* `prefixSubject` folds text before checking for an existing prefix (mobile used default casing, so `İlet:` /
  `YANIT:` got a second prefix). Output strings (`Yanıt:`, `İlet:`) are unchanged.
* `resolveFolderRole` guards an empty delimiter (mobile's `replaceAll('', ' ')` would space out every character;
  no observable difference for matching).
* `buildFolderTree` visits accounts in first-seen order (ids are opaque; mobile sorted numeric ids) and also
  reports `parentId` / `hasChildren`.
* `assignThreads` takes string ids and an injectable fallback-id generator (mobile: int ids + clock).
* Preserved on purpose, even though they look odd: `formatRelative` gives `0 dk önce` at 45–59 s; the quote
  header pattern `From:` matches anywhere; `Fw:` is not recognised as an existing forward prefix.

## Not ported (with reason)

| Mobile | Why |
|---|---|
| `email_html_codec.dart`, `compose_formatting.dart` | Quill-Delta specific; depends on the web editor decision (decision D3, see Phase 2 Final Decisions) |
| `mail_html_document.dart`, `webview_pool.dart` | Flutter WebView; web equivalent is a sandboxed iframe + sanitiser (D2) |
| `notification_text.dart` | pure and portable, but browser notifications are not in scope yet |
| `html_translation.dart`, `translation_*` | translation feature not part of this phase |
| `share_payload.dart`, `share_intake_service.dart`, `image_attachment_resize.dart` | Android share intents / on-device image work |
| `FetchedEnvelope` flag mapping, `EmailAddress.toMap/decodeList` | IMAP / SQLite specifics → server infrastructure |
| `RetentionPolicy`, sync engine, push, pending-operation queue | infrastructure; only its *observable* behaviour (undo window) is in the contract |
| Contacts (`Contacts` table, quick-contacts strip) | deferred by decision D5 |

## Phase 2 Final Decisions

Finalisation pass: these settle the eight open questions of Phase 2. Only contract, domain comments, tests and
this document changed — no backend, no editor, no new dependency, no UI change.

### D1 — Session model: a separate Kaydet user session
* **Decision.** `POST /session` authenticates a **Kaydet user** (`{ identifier, password }`), not one mailbox.
  `SessionDTO` = `{ authenticated, user: { id } | null, expiresAt }`. Mail accounts are separate entities under the
  session (`/accounts` add / update / remove / sync; several at once; the client switches between them). A new error
  code `invalid_credentials` (401) covers a failed sign-in; `mail_credentials_rejected` (422) stays exclusive to
  account creation/update, so mail credentials and Kaydet credentials never share a request or an error.
* **Why.** Multiple accounts, add/remove later, one expiry and one logout for all of them, and credential
  isolation (mail passwords live per account, server-side only) all require an identity above the mailbox.
* **Isolation rule.** Account ids are only meaningful inside their session; another user's account answers
  `account_not_found`, never `forbidden`, so existence is not revealed.
* **Deferred.** How Kaydet users are created (sign-up/invite/admin), the `identifier` format, password hashing,
  cookie/CSRF details, session storage, rate limiting. **Owner: the authentication phase.**

### D2 — HTML sanitisation stays on the server
* **Decision.** `provider/IMAP → raw untrusted HTML → SERVER-SIDE sanitisation → sanitised HTML → API DTO → web
  reader → sandboxed rendering`. Raw provider HTML is not representable in any DTO; `MessageBody.html` keeps the
  literal `sanitized: true`. The browser never makes unsafe HTML trustworthy; it only receives sanitised content and
  still renders it in a sandboxed iframe with a restrictive CSP.
* **Why.** One place to fix and audit; a compromised or buggy client cannot be the only line of defence.
* **Deferred.** The sanitiser (library, allow-list, cid rewriting, remote-content policy) and the reader's iframe
  implementation. The `message/text.ts` helpers (meta-refresh/viewport stripping, colour-scheme pinning) are
  preprocessing only, not sanitisation. **Owner: server phase (sanitiser) and the message-reader phase (rendering).**

### D3 — Compose editor: not chosen
* **Decision.** No editor and no editor dependency yet. Mobile uses Quill-Delta based HTML formatting
  (`email_html_codec.dart`, `compose_formatting.dart`); the web editor does **not** have to be a Quill clone, but
  web compose must preserve the product's mail formatting rules, and the font-size and line-height limits must stay
  consistent with mobile (`ComposeFontSize`: 13/16/20/24 px; `ComposeLineSpacing`: 1 / 1.15 / 1.5 / 2). The contract
  already isolates the editor: a draft carries `bodyText` plus optional `bodyHtml` (user-authored outgoing HTML).
* **Why.** The editor choice drives the HTML generation and sanitisation rules; deciding early would invent them.
* **Deferred.** Editor selection, HTML encode/decode rules, outgoing-HTML sanitisation. **Owner: the Compose phase.**

### D4 — Spam undo: server-resolved
* **Decision.** `spam` is a normal server-resolved action. The response's `undo` token is present only when the
  server made the operation undoable under the mobile/domain rules; the UI must offer "Geri al" from the response.
  `UNDOABLE_ACTION_TYPES` is an optimistic-UI hint, not a promise. (Mobile's `markSpam` currently returns no undo
  handle; the shell's mock still offers one and was left untouched on purpose.)
* **Why.** Whether spam is undoable is product/server behaviour and must not be frozen by the current shell UI.
* **Deferred.** The final undoability of spam. **Owner: server phase, against mobile behaviour.**

### D5 — Contacts and file search: future extensions
* **Decision.** No contacts endpoint/DTO and no attachment/file-search endpoint. Nothing was added as a placeholder.
  Mobile has both (`Contacts` table, quick-contacts strip, `searchAttachments`); they are outside the minimum contract.
* **Deferred.** Recipient autocomplete, "Hızlı Kişiler", the attachment search category. **Owner: a later phase that
  needs them (compose autocomplete / search), each adding its contract first.**

### D6 — Threads: `threadId` only
* **Decision.** `threadId` stays on message DTOs (useful domain information, computed by `threading/`). There is
  **no** thread/conversation endpoint or DTO.
* **Why.** The mobile UI never reads `threadId`; lists show individual messages. The web must not invent a
  conversation model before the product defines one.
* **Deferred.** Conversation view, thread counts, thread actions. **Owner: a product decision first, then a contract.**

### D7 — Attachment upload contract
* **Decision.** `POST /drafts/:draftId/attachments` is multipart, **one file per request** (part `file`), declared in
  the route table as `{ kind: 'multipart', field: 'file', maxFileBytes, maxTotalBytes, streaming: true }`. The server
  validates while **streaming** and must not need the whole file in memory. The browser-supplied MIME type and file
  name are **untrusted**: the server derives the type from the bytes and stores a sanitised display name; the response
  (`AttachmentDTO`) carries the server's values and an **opaque** id, and never a storage location. Policy:
  `attachment/` (`attachmentRejection`: blocked-extension list, empty, too large), enforced by the server whatever the
  browser checked. Rejections are stable codes: `attachment_blocked_type`, `attachment_empty`, `attachment_too_large`.
* **Limits.** 25 MB per file and 50 MB per draft are **mobile's** values (`ShareAttachmentPolicy`), used as the
  contract ceilings. Mobile has no other upload limits; anything stricter (per-request, per-account, rate) is an
  **implementation decision for the server phase**, not invented here.
* **Deferred.** Storage provider and layout, streaming/back-pressure implementation, content-sniffing library,
  malware scanning, orphaned-upload clean-up. **Owner: server phase.**

### D8 — Draft, outbox and message ids are separate
* **Decision.** Three opaque identifiers, never assumed equal:
  `Draft (draftId) → send requested → Outbox operation (outboxId) → SMTP → Message (messageId)`.
  `OutboxDTO` = `{ id (outboxId), accountId, draftId, messageId | null, state, cancellableUntil, error }`;
  `DraftDTO` gains `messageId | null` (its Drafts-folder message once it exists); a draft row in a message list
  carries an optional `draftId` so the client can open it; the `outbox.changed` event names `outboxId` and
  `draftId`. `POST /outbox/:outboxId/cancel` takes the outbox id. `DELETE /drafts/:draftId` was added because a draft
  can no longer be discarded through message actions (its id is not a message id). `putDraft` no longer lists
  `message_not_found`.
* **Why.** A draft outlives a send attempt (cancel, failure, retry) and an outbox operation has its own lifecycle.
* **Deferred.** Outbox implementation, retry policy, how Drafts/Sent message rows are linked internally.
  **Owner: server phase (mail sending).**

### Remaining unresolved decisions
None of D1–D8 is left open. Consequences the owning phases must still settle: the `identifier` format and user
provisioning (auth); sanitiser choice and reader iframe policy (server / reader); editor and outgoing-HTML rules
(Compose); final spam undoability (server); attachment storage and any limits stricter than mobile's (server);
contacts, file search and a conversation view if the product wants them (later, contract first).
