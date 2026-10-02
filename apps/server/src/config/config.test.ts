import { MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_TOTAL_BYTES } from '@kaydet/domain';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadConfiguration } from './index.ts';

const key = (byte: number) => Buffer.alloc(32, byte).toString('base64');
const validKeys = { CREDENTIAL_ENCRYPTION_KEYS: `k1:${key(1)}` };
const production = { NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://mail.example.com', DATABASE_PATH: '/var/lib/kaydet/kaydet.db' };

describe('configuration: safe defaults', () => {
  it('an empty environment yields a development config that binds to loopback and allows only the local web client', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 3001,
      apiPrefix: '/api',
      logLevel: 'info',
      trustProxy: false,
      validateResponses: true,
    });
    expect(config.cors.allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(config.cookie).toMatchObject({ name: 'kaydet_session', secure: false, sameSite: 'lax' });
  });

  it('upload limits default to the domain contract', () => {
    expect(loadConfig({}).limits).toMatchObject({ uploadFileBytes: MAX_ATTACHMENT_FILE_BYTES, uploadTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES });
  });

  it('test mode is silent and allows no cross-origin access unless configured', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.logLevel).toBe('silent');
    expect(config.cors.allowedOrigins).toEqual([]);
  });

  it('empty values count as unset', () => {
    expect(loadConfig({ LOG_LEVEL: '', CORS_ALLOWED_ORIGINS: '', CREDENTIAL_ENCRYPTION_KEYS: '' }).logLevel).toBe('info');
  });

  it('security defaults: 7-day absolute and 8-hour idle sessions, 10-256 character passwords, throttling on', () => {
    const config = loadConfig({});
    expect(config.session).toEqual({ absoluteTtlSeconds: 7 * 86_400, idleTtlSeconds: 8 * 3600, touchIntervalSeconds: 60 });
    expect(config.password).toEqual({ minLength: 10, maxLength: 256 });
    expect(config.loginLimits).toEqual({ maxFailuresPerIdentifier: 5, maxFailuresPerAddress: 20, backoffBaseSeconds: 30, backoffMaxSeconds: 900, windowSeconds: 900 });
    expect(config.cookie.sameSite).toBe('lax');
  });

  it('the cookie is Secure exactly in production, whatever else is set', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).cookie.secure).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test' }).cookie.secure).toBe(false);
    expect(loadConfig({ ...production, ...validKeys }).cookie.secure).toBe(true);
  });
});

describe('configuration: valid environment', () => {
  it('parses every supported variable', () => {
    const config = loadConfig({
      ...production,
      HOST: '0.0.0.0',
      PORT: '8080',
      API_PREFIX: '/v1/',
      LOG_LEVEL: 'warn',
      SESSION_COOKIE_NAME: 'sid',
      SESSION_ABSOLUTE_TTL_SECONDS: '3600',
      SESSION_IDLE_TTL_SECONDS: '600',
      SESSION_COOKIE_SAMESITE: 'strict',
      ...validKeys,
      MAX_JSON_BODY_BYTES: '2048',
      TRUST_PROXY: 'true',
      VALIDATE_RESPONSES: 'true',
    });
    expect(config).toMatchObject({
      nodeEnv: 'production',
      host: '0.0.0.0',
      port: 8080,
      apiPrefix: '/v1',
      logLevel: 'warn',
      trustProxy: true,
      validateResponses: true,
    });
    expect(config.cookie).toEqual({ name: 'sid', secure: true, sameSite: 'strict' });
    expect(config.session).toMatchObject({ absoluteTtlSeconds: 3600, idleTtlSeconds: 600 });
    expect(config.limits.jsonBodyBytes).toBe(2048);
  });

  it('production validates responses only when asked to; development always does by default', () => {
    expect(loadConfig({ ...production, ...validKeys }).validateResponses).toBe(false);
    expect(loadConfig({ NODE_ENV: 'development' }).validateResponses).toBe(true);
  });

  it('normalises and de-duplicates origins', () => {
    const config = loadConfig({ CORS_ALLOWED_ORIGINS: 'https://a.example.com/, https://a.example.com ,http://localhost:5173' });
    expect(config.cors.allowedOrigins).toEqual(['https://a.example.com', 'http://localhost:5173']);
  });
});

describe('configuration: invalid environment', () => {
  const problems = (env: Record<string, string>): string => {
    try {
      loadConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).message;
    }
    throw new Error('expected loadConfig to throw');
  };

  it('rejects unknown NODE_ENV, bad ports and bad log levels, naming every variable', () => {
    const message = problems({ NODE_ENV: 'staging', PORT: '99999', LOG_LEVEL: 'loud' });
    expect(message).toContain('NODE_ENV');
    expect(message).toContain('PORT');
    expect(message).toContain('LOG_LEVEL');
  });

  it('production requires explicit CORS origins', () => {
    expect(problems({ NODE_ENV: 'production' })).toContain('CORS_ALLOWED_ORIGINS');
    expect(problems({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: ' , ' })).toContain('CORS_ALLOWED_ORIGINS');
  });

  it('never accepts a wildcard, a path, credentials or a non-http scheme as an origin', () => {
    for (const bad of ['*', 'https://a.example.com/path', 'https://user:pw@a.example.com', 'ftp://a.example.com', 'a.example.com', 'null']) {
      expect(problems({ CORS_ALLOWED_ORIGINS: bad }), bad).toContain('CORS_ALLOWED_ORIGINS');
    }
  });

  it('production requires credential encryption keys', () => {
    expect(problems(production)).toContain('CREDENTIAL_ENCRYPTION_KEYS');
    expect(() => loadConfiguration({ ...production, ...validKeys })).not.toThrow();
  });

  it('production origins must be https', () => {
    expect(problems({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'http://mail.example.com' })).toContain('https');
  });

  it('rejects inconsistent upload limits and unsafe cookie names / prefixes', () => {
    expect(problems({ MAX_UPLOAD_FILE_BYTES: '2000000', MAX_UPLOAD_TOTAL_BYTES: '1000000' })).toContain('MAX_UPLOAD_FILE_BYTES');
    expect(problems({ SESSION_COOKIE_NAME: 'bad name;' })).toContain('SESSION_COOKIE_NAME');
    expect(problems({ API_PREFIX: 'api' })).toContain('API_PREFIX');
  });
});

describe('configuration: security settings', () => {
  const problems = (env: Record<string, string>): string => {
    try {
      loadConfiguration(env);
    } catch (error) {
      return (error as ConfigError).message;
    }
    throw new Error('expected loadConfiguration to throw');
  };

  it('rejects inconsistent lifetimes, password limits and back-off', () => {
    expect(problems({ SESSION_IDLE_TTL_SECONDS: '5000', SESSION_ABSOLUTE_TTL_SECONDS: '4000' })).toContain('SESSION_IDLE_TTL_SECONDS');
    expect(problems({ SESSION_IDLE_TTL_SECONDS: '30', SESSION_TOUCH_INTERVAL_SECONDS: '60' })).toContain('SESSION_TOUCH_INTERVAL_SECONDS');
    expect(problems({ PASSWORD_MIN_LENGTH: '100', PASSWORD_MAX_LENGTH: '64' })).toContain('PASSWORD_MIN_LENGTH');
    expect(problems({ LOGIN_BACKOFF_BASE_SECONDS: '600', LOGIN_BACKOFF_MAX_SECONDS: '60' })).toContain('LOGIN_BACKOFF_BASE_SECONDS');
    expect(problems({ SESSION_COOKIE_SAMESITE: 'none' })).toContain('SESSION_COOKIE_SAMESITE'); // never SameSite=None
  });

  it('parses credential keys: several keys, an active id, url-safe base64', () => {
    const { secrets } = loadConfiguration({ NODE_ENV: 'test', CREDENTIAL_ENCRYPTION_KEYS: `old:${key(1)}, new:${Buffer.alloc(32, 2).toString('base64url')}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'new' });
    expect(secrets.credentialKeys?.activeKeyId).toBe('new');
    expect([...(secrets.credentialKeys?.keys.keys() ?? [])]).toEqual(['old', 'new']);
    expect(secrets.credentialKeys?.keys.get('old')).toEqual(new Uint8Array(32).fill(1));
  });

  it('a single key is active by default; several keys need an explicit active id that exists', () => {
    expect(loadConfiguration({ NODE_ENV: 'test', CREDENTIAL_ENCRYPTION_KEYS: `only:${key(3)}` }).secrets.credentialKeys?.activeKeyId).toBe('only');
    expect(problems({ CREDENTIAL_ENCRYPTION_KEYS: `a:${key(1)},b:${key(2)}` })).toContain('CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID');
    expect(problems({ CREDENTIAL_ENCRYPTION_KEYS: `a:${key(1)}`, CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'zzz' })).toContain('CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID');
    expect(problems({ CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'a' })).toContain('CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID');
  });

  it('rejects malformed, short and duplicate keys — naming the id, never the material', () => {
    const shortKey = Buffer.alloc(16, 9).toString('base64');
    const message = problems({ CREDENTIAL_ENCRYPTION_KEYS: `a:${shortKey},b:not*base64,a:${key(1)},bad id:${key(1)}` });
    expect(message).toContain('key "a" must be exactly 32 bytes');
    expect(message).toContain('key "b" must be exactly 32 bytes');
    expect(message).toContain('every entry must look like');
    expect(message).not.toContain(shortKey);
  });

  it('keys are NOT part of the public config the HTTP layer receives', () => {
    const { config } = loadConfiguration({ NODE_ENV: 'test', CREDENTIAL_ENCRYPTION_KEYS: `k:${key(5)}` });
    expect(JSON.stringify(config)).not.toContain(key(5));
    expect(Object.keys(config)).not.toContain('credentialKeys');
  });
});
