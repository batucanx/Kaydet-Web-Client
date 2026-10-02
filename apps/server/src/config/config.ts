/**
 * Step 2 — configuration VALIDATION and derivation: cross-field rules and environment-specific defaults, giving
 * the runtime `ServerConfig` (public) and `ServerSecrets` (composition root only). Development gets the local web
 * client as its only allowed origin; production must name its origins and its credential-encryption keys.
 */
import { isAbsolute, resolve } from 'node:path';
import { ConfigError, parseEnv } from './env.ts';
import type { ParsedEnv } from './env.ts';
import type { CredentialKeyConfig, ServerConfig, ServerSecrets } from './config.types.ts';

const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'] as const;

/** `scheme://host[:port]` with nothing else, and never `*`. Returns the normalised origin or null. */
function normaliseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === 'null') return null;
    if (value.replace(/\/$/, '') !== url.origin) return null; // path, query, credentials…
    return url.origin;
  } catch {
    return null;
  }
}

function resolveOrigins(env: ParsedEnv, problems: string[]): string[] {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (raw === undefined) {
    if (env.NODE_ENV === 'production') problems.push('CORS_ALLOWED_ORIGINS: required in production (explicit, comma-separated origins)');
    return env.NODE_ENV === 'development' ? [...DEV_ORIGINS] : [];
  }
  const origins: string[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const origin = normaliseOrigin(entry);
    if (origin === null) {
      problems.push(`CORS_ALLOWED_ORIGINS: "${entry.slice(0, 80)}" is not an exact origin (scheme://host[:port]; no wildcard, path or credentials)`);
    } else if (env.NODE_ENV === 'production' && origin.startsWith('http://')) {
      problems.push(`CORS_ALLOWED_ORIGINS: "${origin}" must use https in production`);
    } else {
      origins.push(origin);
    }
  }
  if (env.NODE_ENV === 'production' && origins.length === 0 && problems.length === 0) {
    problems.push('CORS_ALLOWED_ORIGINS: at least one origin is required in production');
  }
  return [...new Set(origins)];
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_BYTES = 32;

/** Decodes standard or URL-safe base64 to bytes; `null` when it is not valid base64. */
function decodeBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null;
  return Uint8Array.from(Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/'), 'base64'));
}

/** `id:base64,id2:base64` + active id → key config. Problems name the variable / key id, never key material. */
function resolveCredentialKeys(env: ParsedEnv, problems: string[]): CredentialKeyConfig | null {
  const raw = env.CREDENTIAL_ENCRYPTION_KEYS;
  if (raw === undefined) {
    if (env.NODE_ENV === 'production') {
      problems.push('CREDENTIAL_ENCRYPTION_KEYS: required in production (mail credentials must be encrypted with a configured key)');
    }
    if (env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID !== undefined) {
      problems.push('CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: set without CREDENTIAL_ENCRYPTION_KEYS');
    }
    return null;
  }

  const before = problems.length;
  const keys = new Map<string, Uint8Array>();
  for (const entry of raw.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const at = entry.indexOf(':');
    const id = at < 0 ? '' : entry.slice(0, at);
    if (!KEY_ID.test(id)) {
      problems.push('CREDENTIAL_ENCRYPTION_KEYS: every entry must look like "<id>:<base64 key>" with an id of 1-32 letters, digits, "_" or "-"');
      continue;
    }
    const material = decodeBase64(entry.slice(at + 1));
    if (material === null || material.length !== KEY_BYTES) {
      problems.push(`CREDENTIAL_ENCRYPTION_KEYS: key "${id}" must be exactly ${KEY_BYTES} bytes, base64-encoded`);
    } else if (keys.has(id)) {
      problems.push(`CREDENTIAL_ENCRYPTION_KEYS: duplicate key id "${id}"`);
    } else {
      keys.set(id, material);
    }
  }
  if (keys.size === 0 && problems.length === before) problems.push('CREDENTIAL_ENCRYPTION_KEYS: at least one key is required when the variable is set');

  const onlyKey = keys.size === 1 ? [...keys.keys()][0] : undefined;
  const activeKeyId = env.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID ?? onlyKey;
  if (problems.length === before) {
    if (activeKeyId === undefined) problems.push('CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: required when several keys are configured');
    else if (!keys.has(activeKeyId)) problems.push('CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: does not name a configured key');
  }
  return problems.length > before || activeKeyId === undefined ? null : { activeKeyId, keys };
}

/**
 * Where the database lives. Never silently created somewhere unexpected: production must NAME an absolute path (and the
 * server will not create its directory); development defaults to `./data/kaydet.db` under the working directory; `:memory:`
 * and "no database" (in-memory repositories, the default under NODE_ENV=test) are never allowed in production.
 */
function resolveDatabasePath(env: ParsedEnv, problems: string[]): string | null {
  const raw = env.DATABASE_PATH;
  if (env.NODE_ENV === 'production') {
    if (raw === undefined) problems.push('DATABASE_PATH: required in production (an absolute path to the SQLite file on persistent storage)');
    else if (raw === ':memory:') problems.push('DATABASE_PATH: ":memory:" is not allowed in production');
    else if (!isAbsolute(raw)) problems.push('DATABASE_PATH: must be an absolute path in production');
    return raw ?? null;
  }
  if (raw === undefined) return env.NODE_ENV === 'development' ? resolve('data', 'kaydet.db') : null;
  return raw === ':memory:' ? raw : resolve(raw);
}

function validate(env: ParsedEnv) {
  const problems: string[] = [];
  const origins = resolveOrigins(env, problems);
  const credentialKeys = resolveCredentialKeys(env, problems);
  if (env.MAX_UPLOAD_FILE_BYTES > env.MAX_UPLOAD_TOTAL_BYTES) problems.push('MAX_UPLOAD_FILE_BYTES: must not exceed MAX_UPLOAD_TOTAL_BYTES');
  if (env.SESSION_IDLE_TTL_SECONDS > env.SESSION_ABSOLUTE_TTL_SECONDS) problems.push('SESSION_IDLE_TTL_SECONDS: must not exceed SESSION_ABSOLUTE_TTL_SECONDS');
  if (env.SESSION_TOUCH_INTERVAL_SECONDS >= env.SESSION_IDLE_TTL_SECONDS) problems.push('SESSION_TOUCH_INTERVAL_SECONDS: must be shorter than SESSION_IDLE_TTL_SECONDS');
  if (env.PASSWORD_MIN_LENGTH > env.PASSWORD_MAX_LENGTH) problems.push('PASSWORD_MIN_LENGTH: must not exceed PASSWORD_MAX_LENGTH');
  if (env.LOGIN_BACKOFF_BASE_SECONDS > env.LOGIN_BACKOFF_MAX_SECONDS) problems.push('LOGIN_BACKOFF_BASE_SECONDS: must not exceed LOGIN_BACKOFF_MAX_SECONDS');
  const databasePath = resolveDatabasePath(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return { origins, credentialKeys, databasePath };
}

export function buildConfig(env: ParsedEnv): ServerConfig {
  const { origins, databasePath } = validate(env);
  const production = env.NODE_ENV === 'production';
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    apiPrefix: env.API_PREFIX === '/' ? '' : env.API_PREFIX.replace(/\/+$/, ''),
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    trustProxy: env.TRUST_PROXY,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    cors: { allowedOrigins: origins },
    cookie: { name: env.SESSION_COOKIE_NAME, secure: production, sameSite: env.SESSION_COOKIE_SAMESITE },
    session: {
      absoluteTtlSeconds: env.SESSION_ABSOLUTE_TTL_SECONDS,
      idleTtlSeconds: env.SESSION_IDLE_TTL_SECONDS,
      touchIntervalSeconds: env.SESSION_TOUCH_INTERVAL_SECONDS,
    },
    password: { minLength: env.PASSWORD_MIN_LENGTH, maxLength: env.PASSWORD_MAX_LENGTH },
    loginLimits: {
      maxFailuresPerIdentifier: env.LOGIN_MAX_FAILURES_PER_IDENTIFIER,
      maxFailuresPerAddress: env.LOGIN_MAX_FAILURES_PER_ADDRESS,
      backoffBaseSeconds: env.LOGIN_BACKOFF_BASE_SECONDS,
      backoffMaxSeconds: env.LOGIN_BACKOFF_MAX_SECONDS,
      windowSeconds: env.LOGIN_FAILURE_WINDOW_SECONDS,
    },
    limits: {
      jsonBodyBytes: env.MAX_JSON_BODY_BYTES,
      draftBodyBytes: env.MAX_DRAFT_BODY_BYTES,
      uploadFileBytes: env.MAX_UPLOAD_FILE_BYTES,
      uploadTotalBytes: env.MAX_UPLOAD_TOTAL_BYTES,
    },
    validateResponses: env.VALIDATE_RESPONSES ?? !production,
    database: { path: databasePath, busyTimeoutMs: env.DATABASE_BUSY_TIMEOUT_MS, createDirectory: env.NODE_ENV !== 'production' },
  };
}

/** The secret part of the configuration (composition root only). */
export function buildSecrets(env: ParsedEnv): ServerSecrets {
  return { credentialKeys: validate(env).credentialKeys };
}

/** Parse + validate in one step: the public configuration only (no secrets). */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  return buildConfig(parseEnv(env));
}

/** Public configuration AND secrets from one environment (`main.ts`). */
export function loadConfiguration(env: Readonly<Record<string, string | undefined>>): { config: ServerConfig; secrets: ServerSecrets } {
  const parsed = parseEnv(env);
  return { config: buildConfig(parsed), secrets: buildSecrets(parsed) };
}
