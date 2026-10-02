/**
 * Step 1 — environment PARSING: raw strings → typed values, with defaults. Knows nothing about which values are
 * acceptable together (that is `config.ts`). `process.env` is passed in by `main.ts`; nothing here reads it.
 */
import { MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_TOTAL_BYTES } from '@kaydet/domain';
import { z } from 'zod';
import { LOG_LEVELS, NODE_ENVS, SAME_SITE_MODES } from './config.types.ts';

const emptyToUndefined = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

const bool = z.stringbool({ truthy: ['true', '1'], falsy: ['false', '0'] });
const bytes = z.coerce.number().int().min(1024).max(1024 ** 3);
const seconds = (max = 365 * 86_400) => z.coerce.number().int().min(1).max(max);
const count = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  API_PREFIX: z.string().regex(/^\/[A-Za-z0-9._~/-]*$/, 'must start with "/" and contain only URL-safe characters').default('/api'),
  LOG_LEVEL: optional(z.enum(LOG_LEVELS)),
  CORS_ALLOWED_ORIGINS: optional(z.string()),

  // Session cookie + lifetimes. Defaults: 7 days absolute, 8 hours idle.
  SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default('kaydet_session'),
  SESSION_COOKIE_SAMESITE: z.enum(SAME_SITE_MODES).default('lax'),
  SESSION_ABSOLUTE_TTL_SECONDS: seconds().default(7 * 86_400),
  SESSION_IDLE_TTL_SECONDS: seconds().default(8 * 3600),
  SESSION_TOUCH_INTERVAL_SECONDS: seconds(3600).default(60),

  // Password policy (applied when a password is SET; login only bounds the input length).
  PASSWORD_MIN_LENGTH: count(8, 128).default(10),
  PASSWORD_MAX_LENGTH: count(64, 1024).default(256),

  // Login throttling.
  LOGIN_MAX_FAILURES_PER_IDENTIFIER: count(1, 100).default(5),
  LOGIN_MAX_FAILURES_PER_ADDRESS: count(1, 1000).default(20),
  LOGIN_BACKOFF_BASE_SECONDS: seconds(3600).default(30),
  LOGIN_BACKOFF_MAX_SECONDS: seconds(86_400).default(900),
  LOGIN_FAILURE_WINDOW_SECONDS: seconds(86_400).default(900),

  // Credential encryption keys: "id:base64key,id2:base64key" (32 raw bytes each) + which one encrypts. SECRET.
  CREDENTIAL_ENCRYPTION_KEYS: optional(z.string()),
  CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: optional(z.string()),

  // Database: a SQLite file. REQUIRED (absolute path) in production; development defaults to ./data/kaydet.db.
  DATABASE_PATH: optional(z.string().trim().min(1).max(1024)),
  DATABASE_BUSY_TIMEOUT_MS: z.coerce.number().int().min(0).max(60_000).default(5000),

  MAX_JSON_BODY_BYTES: bytes.default(1024 * 1024),
  MAX_DRAFT_BODY_BYTES: bytes.default(16 * 1024 * 1024),
  MAX_UPLOAD_FILE_BYTES: bytes.default(MAX_ATTACHMENT_FILE_BYTES),
  MAX_UPLOAD_TOTAL_BYTES: bytes.default(MAX_ATTACHMENT_TOTAL_BYTES),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
  TRUST_PROXY: bool.default(false),
  VALIDATE_RESPONSES: optional(bool),
});
export type ParsedEnv = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid server configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Parses raw environment variables. Problem messages name the variable, never echo its value (secrets). */
export function parseEnv(env: Readonly<Record<string, string | undefined>>): ParsedEnv {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`));
  }
  return result.data;
}
