/** Validated runtime configuration. Built once at startup (`loadConfig`) and injected — never read `process.env` elsewhere. */
export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const SAME_SITE_MODES = ['lax', 'strict'] as const;
export type SameSiteMode = (typeof SAME_SITE_MODES)[number];

/** Name of the request header that carries the CSRF token (lower-case, as Node exposes it). */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * The security policy the APPLICATION layer needs (sessions, passwords, login throttling). Plain numbers; no
 * secrets. Passed to `createApplication`, so use cases and services never read configuration themselves.
 */
export interface SecurityPolicy {
  readonly session: {
    /** Hard upper bound of a session's life, from login. */
    readonly absoluteTtlSeconds: number;
    /** A session unused for this long is dead, however much of its absolute lifetime is left. */
    readonly idleTtlSeconds: number;
    /** `lastSeenAt` is only rewritten when older than this (avoids a write per request). */
    readonly touchIntervalSeconds: number;
  };
  readonly password: {
    readonly minLength: number;
    readonly maxLength: number;
  };
  readonly loginLimits: {
    /** Failed attempts per normalised identifier before the backoff starts. */
    readonly maxFailuresPerIdentifier: number;
    /** Failed attempts per client address before the backoff starts. */
    readonly maxFailuresPerAddress: number;
    /** First lock duration; doubles with every further failure. */
    readonly backoffBaseSeconds: number;
    readonly backoffMaxSeconds: number;
    /** Failures are forgotten after this long without a new one. */
    readonly windowSeconds: number;
  };
}

export interface ServerConfig extends SecurityPolicy {
  readonly nodeEnv: NodeEnv;
  readonly host: string;
  readonly port: number;
  /** Prefix of every contract route (`/api`). `/health` and `/ready` are not prefixed. */
  readonly apiPrefix: string;
  readonly logLevel: LogLevel;
  readonly trustProxy: boolean;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly cors: {
    /** Exact origins (`scheme://host[:port]`). Never a wildcard. Empty = no cross-origin browser access. */
    readonly allowedOrigins: readonly string[];
  };
  /** Session cookie attributes (the lifetimes live in `session`, inherited from `SecurityPolicy`). */
  readonly cookie: {
    readonly name: string;
    /** `Secure` attribute: always on in production. */
    readonly secure: boolean;
    readonly sameSite: SameSiteMode;
  };
  readonly limits: {
    /** Default JSON body limit. */
    readonly jsonBodyBytes: number;
    /** Limit of the draft upsert (bodies up to the contract's text/html maxima). */
    readonly draftBodyBytes: number;
    readonly uploadFileBytes: number;
    readonly uploadTotalBytes: number;
  };
  /** Validate every response against the contract schema (development/test: detects contract drift). */
  readonly validateResponses: boolean;
  readonly database: {
    /** SQLite file (absolute). `null` = in-memory repositories (only outside production; the default in tests). */
    readonly path: string | null;
    readonly busyTimeoutMs: number;
    /** May the server create the parent directory? Development only. */
    readonly createDirectory: boolean;
  };
}

/**
 * Secret configuration. Kept OUT of `ServerConfig` on purpose: the HTTP layer receives `ServerConfig`, and it must
 * never be able to reach key material. Only the composition root sees this. Never log it.
 */
export interface ServerSecrets {
  /**
   * Keys for encrypting mail credentials at rest. `null` = none configured (allowed outside production, where the
   * composition root uses a per-process throw-away key; a production config without keys is rejected at startup).
   */
  readonly credentialKeys: CredentialKeyConfig | null;
}

export interface CredentialKeyConfig {
  /** Key that new encryptions use. */
  readonly activeKeyId: string;
  /** All keys that can still DECRYPT (old keys stay until every record is re-encrypted). Raw 32-byte keys. */
  readonly keys: ReadonlyMap<string, Uint8Array>;
}
