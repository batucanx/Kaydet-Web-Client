# Kaydet Web Client

## Mobile Source of Truth

The existing Flutter mobile application is the authoritative source of truth for
Kaydet product behavior, business rules, domain logic, terminology, and applicable UI behavior.

Mobile application root:

C:\Project\Kaydet

When implementing or modifying a feature that already exists in the mobile application:

1. Inspect the corresponding implementation in `C:\Project\Kaydet` before making assumptions.
2. Inspect relevant domain models, use cases, services, state management, and tests.
3. Trace the actual mobile behavior and business rules.
4. Port/adapt that behavior to the web architecture rather than inventing new rules.
5. Keep web-specific UI adaptations where appropriate, but do not change the underlying product behavior without a clear reason.

The mobile application is read-only from the perspective of the web project.
Do not modify files inside `C:\Project\Kaydet` unless explicitly requested.

If `C:\Project\Kaydet` is unavailable or cannot be accessed, do not guess the mobile behavior.
Report the limitation and continue only where the existing web code and project requirements are sufficient.



## Project Purpose

This is the web version of **Kaydet**, an existing Flutter email client.

The existing mobile application is the **source of truth** for product behavior, business rules, features, terminology, and design language.

The goal is to build the **same Kaydet product for the web**, not a generic Gmail/Outlook clone.

When behavior is unclear, inspect the mobile implementation before making assumptions.

---

## Stack

### Frontend

* React
* TypeScript
* Vite

### Backend

* Node.js
* TypeScript

### Testing

* Vitest
* React Testing Library
* Playwright

Use the existing project dependencies and architecture when possible. Do not add libraries without a clear reason.

---

## Architecture

Keep a clear separation between:

```text
Frontend
    ↓
Backend API
    ↓
Domain / Mail Services
    ↓
IMAP / SMTP / Infrastructure
```

The browser must **never connect directly to IMAP or SMTP**.

The backend owns:

* IMAP
* SMTP
* Mail synchronization
* Folder mapping
* Threading
* Sending
* Draft operations
* Attachments
* Provider-specific behavior
* Authentication/session security

Protocol-specific library types must not leak into the frontend.

The frontend should use application/domain models.

---

## Mobile → Web Parity

The mobile application is the primary reference.

Preserve applicable mobile functionality, including:

* Accounts
* Inbox and folders
* Custom folders
* Threading
* Search
* Read/unread
* Star/favorite
* Archive
* Delete
* Move
* Drafts
* Compose
* Reply
* Reply all
* Forward
* Attachments
* Sync/refresh
* Account switching
* Loading states
* Empty states
* Error states
* Relevant offline behavior

Do not remove functionality simply because web implementation is inconvenient.

Web interactions may be adapted for desktop conventions, but the **product behavior and identity must remain consistent**.

Responsive design means adapting the experience intelligently, not simply shrinking the mobile UI.

---

## Design System

Preserve Kaydet's existing visual language.

Use centralized design tokens for:

* Colors
* Typography
* Spacing
* Radius
* Shadows
* Motion
* Breakpoints
* Component states

Do not scatter arbitrary colors or design values throughout components.

Do not hardcode colors that break light/dark themes.

Avoid generic AI-generated UI, excessive glassmorphism, unnecessary gradients, excessive rounded containers, and visual noise.

The result should feel like a polished commercial email application.

Use the project's UI/UX skills for detailed visual work.

---

## Security

Security-sensitive operations belong on the backend.

Never expose to the browser:

* Email passwords
* IMAP/SMTP credentials
* Private keys
* Server secrets
* API secrets

Never place server secrets in Vite client-side environment variables.

Treat email HTML as **untrusted content**.

Sanitize HTML email before rendering and protect against XSS and unsafe embedded content.

Never bypass browser security merely to make email rendering work.

Do not log credentials, tokens, or sensitive mail content.

Use the installed security skills for detailed security reviews.

---

## TypeScript & Code Quality

Use strict TypeScript.

Prefer explicit domain types and typed API boundaries.

Avoid `any` unless there is a documented reason.

Do not silence TypeScript errors with careless casts.

Prefer simple, maintainable solutions over unnecessary abstraction.

Do not over-engineer hypothetical future requirements.

Do not rewrite working architecture without a concrete reason.

---

## Investigate Before Changing

Do not guess about existing code.

When a task concerns existing behavior:

1. Inspect the relevant files.
2. Trace the relevant data flow.
3. Check related domain/business logic.
4. Check existing tests.
5. Then implement the smallest appropriate change.

If the mobile implementation can answer a question, inspect it instead of inventing behavior.

Do not modify unrelated files or features.

---

## UI Quality

Every feature should account for:

* Loading
* Empty
* Error
* Success
* Hover
* Focus
* Active
* Disabled
* Responsive states

Use semantic HTML and accessible interaction patterns.

Keyboard navigation and focus management matter.

Respect reduced-motion preferences.

Verify important UI changes in a real browser using the installed browser/visual QA skills.

---

## Performance

Email lists may contain large numbers of messages.

Use appropriate techniques when needed:

* Virtualization
* Lazy loading
* Code splitting
* Efficient rendering
* Caching
* Minimal unnecessary rerenders
* Efficient network requests

Do not prematurely optimize, but avoid architecture that obviously cannot scale.

---

## Testing

Use tests to verify real behavior.

Use:

* **Vitest** for unit logic
* **React Testing Library** for component behavior
* **Playwright** for browser workflows

Important workflows should be covered where applicable:

* Account setup/login
* Account switching
* Folder navigation
* Opening messages
* Thread interaction
* Search
* Read/unread
* Star
* Archive
* Delete
* Move
* Compose
* Reply
* Forward
* Attachments
* Draft saving
* Sending

Tests verify correctness; do not implement special-case code merely to satisfy tests.

---

## Skills

Project-specific skills are located in:

```text
.claude/skills/
```

Use the relevant installed skill when its purpose matches the task.

Important skill categories include:

* React/frontend engineering
* UI/UX
* Visual QA
* Accessibility
* Browser testing
* Security
* Performance
* Code review
* Refactoring

`ui-ux-pro-max` is available at project level.

Do not duplicate skill procedures inside this file.

**CLAUDE.md contains permanent project rules; Skills contain specialized workflows.**

---

## Change Discipline

Keep changes scoped.

Do not:

* Rewrite unrelated code
* Remove existing functionality
* Replace working dependencies without reason
* Perform destructive Git operations
* Delete user changes
* Introduce unnecessary abstractions
* Add dependencies casually

Preserve existing work.

If a large architectural change is genuinely required, explain the reason before proceeding.

---

## Definition of Done

A feature is complete when:

* Required behavior works.
* Mobile parity has been checked.
* The Kaydet design language is preserved.
* Responsive behavior works.
* Loading/empty/error states are handled.
* Security implications are addressed.
* Accessibility is considered.
* Relevant tests pass.
* Browser verification is performed when appropriate.
* TypeScript/lint/build checks pass.
* No unrelated regressions are introduced.

---

## Core Rule

**Build Kaydet Web Client, not a generic email application.**

When making a decision, prefer:

**Existing Kaydet behavior → correct web adaptation → established web convention → simplest implementation.**

If the answer can be obtained by inspecting the existing code, inspect it instead of guessing.
