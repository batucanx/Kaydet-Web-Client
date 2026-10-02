/**
 * @kaydet/domain — pure TypeScript Kaydet rules + the browser-safe API contract.
 *
 * Shared by apps/web and (later) apps/server. No React, no DOM/Node APIs, no IMAP/SMTP/SQLite: enforced by
 * tsconfig (no DOM/Node typings), ESLint (restricted imports/globals) and `scripts/check-boundaries.mjs`.
 */
export * from './actions/index.ts';
export * from './address/index.ts';
export * from './api/index.ts';
export * from './attachment/index.ts';
export * from './dates/index.ts';
export * from './draft/index.ts';
export * from './folder/index.ts';
export * from './labels/index.ts';
export * from './message/index.ts';
export * from './search/index.ts';
export * from './threading/index.ts';
export * from './turkish/index.ts';
