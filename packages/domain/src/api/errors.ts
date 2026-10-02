/**
 * Browser-safe error contract.
 *
 * SOURCE: mobile `lib/core/result.dart` → `AppFailure` and its subclasses (Turkish `userMessage`, `isActionable`).
 * PURPOSE: A stable, closed set of error CODES the browser can branch on, grouped into the nine kinds the
 *          product distinguishes. Each code has one HTTP status, one retry policy and one user-safe Turkish
 *          message. Raw IMAP/SMTP text, hostnames, stack traces and server internals are NEVER part of an
 *          error: mobile keeps `detail` for logs only, and so does the server — `ApiError` has no free-text
 *          detail field at all. The only structured extras are user-visible data the UI needs to show
 *          (rejected recipient addresses, missing file names, field paths, retry delay).
 * WEB USAGE: every non-2xx response is `{ error: ApiError }`; the client maps `code` → UI (inline field error,
 *            toast, retry affordance, "sign in again").
 */
import { z } from 'zod';

export const ERROR_KINDS = [
  'validation',
  'authentication',
  'authorization',
  'not_found',
  'conflict',
  'network',
  'provider',
  'sync_temporary',
  'operation_permanent',
] as const;
export type ApiErrorKind = (typeof ERROR_KINDS)[number];

interface ErrorDefinition {
  readonly kind: ApiErrorKind;
  /** HTTP status the server answers with (0 = produced by the client, never on the wire). */
  readonly status: number;
  /** Would repeating the same request later plausibly succeed? Drives the retry affordance. */
  readonly retryable: boolean;
  /** Safe, user-facing Turkish text (mobile wording where a mobile equivalent exists). */
  readonly message: string;
}

const define = <const T extends Record<string, ErrorDefinition>>(defs: T): T => defs;

export const ERROR_DEFINITIONS = define({
  // ── validation ────────────────────────────────────────────────────────────
  invalid_request: { kind: 'validation', status: 400, retryable: false, message: 'İstek geçersiz.' },
  invalid_cursor: { kind: 'validation', status: 400, retryable: false, message: 'Liste konumu geçersiz. Listeyi yenileyin.' },
  invalid_folder_name: {
    kind: 'validation', status: 400, retryable: false,
    message: 'Klasör adı boş bırakılamaz ve dizin ayırıcı karakter içeremez.',
  },
  invalid_recipient: { kind: 'validation', status: 400, retryable: false, message: 'Geçersiz alıcı adresi.' },
  no_recipients: { kind: 'validation', status: 400, retryable: false, message: 'En az bir alıcı girin.' },
  invalid_action_combination: {
    kind: 'validation', status: 400, retryable: false, message: 'Bu eylemler birlikte uygulanamaz.',
  },
  attachment_blocked_type: {
    kind: 'validation', status: 400, retryable: false, message: 'Bu dosya türü güvenlik nedeniyle eklenemez.',
  },
  attachment_empty: { kind: 'validation', status: 400, retryable: false, message: 'Boş dosya eklenemez.' },
  attachment_too_large: { kind: 'validation', status: 413, retryable: false, message: 'Dosya çok büyük.' },

  // ── authentication ────────────────────────────────────────────────────────
  not_authenticated: { kind: 'authentication', status: 401, retryable: false, message: 'Oturum açmanız gerekiyor.' },
  session_expired: { kind: 'authentication', status: 401, retryable: false, message: 'Oturumunuzun süresi doldu. Yeniden giriş yapın.' },
  // Kaydet sign-in failed (wrong identifier or password). Deliberately the same answer for both.
  invalid_credentials: {
    kind: 'authentication', status: 401, retryable: false, message: 'Giriş bilgileri hatalı.',
  },
  // The MAIL provider rejected the credentials (mobile `AuthFailure`). Deliberately NOT 401: a 401 tells the
  // client its Kaydet session is gone and would sign the user out.
  mail_credentials_rejected: {
    kind: 'authentication', status: 422, retryable: false, message: 'E-posta adresi veya şifre hatalı.',
  },

  // ── authorization ─────────────────────────────────────────────────────────
  forbidden: { kind: 'authorization', status: 403, retryable: false, message: 'Bu işlem için yetkiniz yok.' },

  // ── not found ─────────────────────────────────────────────────────────────
  account_not_found: { kind: 'not_found', status: 404, retryable: false, message: 'Hesap bulunamadı.' },
  folder_not_found: { kind: 'not_found', status: 404, retryable: false, message: 'Klasör bulunamadı.' },
  message_not_found: { kind: 'not_found', status: 404, retryable: false, message: 'İleti bulunamadı. Silinmiş olabilir.' },
  attachment_not_found: { kind: 'not_found', status: 404, retryable: false, message: 'Ek dosyası bulunamadı.' },
  draft_not_found: { kind: 'not_found', status: 404, retryable: false, message: 'Taslak bulunamadı.' },
  outbox_item_not_found: { kind: 'not_found', status: 404, retryable: false, message: 'Giden kutusu öğesi bulunamadı.' },
  label_not_found: { kind: 'not_found', status: 404, retryable: false, message: 'Etiket bulunamadı.' },
  signature_not_found: { kind: 'not_found', status: 404, retryable: false, message: 'İmza bulunamadı.' },
  template_not_found: { kind: 'not_found', status: 404, retryable: false, message: 'Şablon bulunamadı.' },

  // ── conflict ──────────────────────────────────────────────────────────────
  account_exists: { kind: 'conflict', status: 409, retryable: false, message: 'Bu hesap zaten ekli.' },
  folder_exists: { kind: 'conflict', status: 409, retryable: false, message: 'Bu adda bir klasör zaten var.' },
  folder_has_children: {
    kind: 'conflict', status: 409, retryable: false,
    message: 'Alt klasörleri olan bir klasör silinemez. Önce alt klasörleri taşıyın veya silin.',
  },
  invalid_folder_move: { kind: 'conflict', status: 409, retryable: false, message: 'Klasör kendi alt klasörüne taşınamaz.' },
  system_folder_protected: {
    kind: 'conflict', status: 409, retryable: false, message: 'Sistem klasörleri üzerinde bu işlem yapılamaz.',
  },
  label_exists: { kind: 'conflict', status: 409, retryable: false, message: 'Bu adda bir etiket zaten var.' },
  message_scope_mismatch: {
    kind: 'conflict', status: 409, retryable: false, message: 'İletiler seçilen hesaba ait değil.',
  },
  permanent_delete_requires_confirmation: {
    kind: 'conflict', status: 409, retryable: false, message: 'Kalıcı silme için onay gerekiyor.',
  },
  draft_already_sent: { kind: 'conflict', status: 409, retryable: false, message: 'Bu taslak zaten gönderildi.' },

  // ── network / service ─────────────────────────────────────────────────────
  network_unreachable: {
    kind: 'network', status: 0, retryable: true, message: 'Sunucuya ulaşılamıyor. Bağlantınızı kontrol edin.',
  },
  service_unavailable: { kind: 'network', status: 503, retryable: true, message: 'Hizmet şu anda kullanılamıyor.' },
  request_timeout: { kind: 'network', status: 504, retryable: true, message: 'İstek zaman aşımına uğradı.' },
  rate_limited: { kind: 'network', status: 429, retryable: true, message: 'Çok fazla istek. Biraz sonra tekrar deneyin.' },

  // ── mail provider ─────────────────────────────────────────────────────────
  provider_unreachable: {
    kind: 'provider', status: 502, retryable: true, message: 'Posta sunucusuna ulaşılamıyor. Bağlantınızı kontrol edin.',
  },
  provider_tls_failed: {
    kind: 'provider', status: 502, retryable: false,
    message: 'Güvenli bağlantı kurulamadı. Port ve güvenlik ayarlarını kontrol edin.',
  },
  provider_rejected: { kind: 'provider', status: 502, retryable: false, message: 'Posta sunucusu isteği reddetti.' },
  provider_mailbox_missing: {
    kind: 'provider', status: 502, retryable: false, message: 'Klasör posta sunucusunda bulunamadı.',
  },
  recipient_rejected: { kind: 'provider', status: 422, retryable: false, message: 'Alıcı reddedildi. Adresi kontrol edin.' },
  quota_exceeded: { kind: 'provider', status: 507, retryable: false, message: 'Posta kutusu dolu. Yer açmanız gerekiyor.' },

  // ── temporary synchronisation ─────────────────────────────────────────────
  folder_resyncing: { kind: 'sync_temporary', status: 503, retryable: true, message: 'Klasör yeniden eşitleniyor.' },
  sync_failed_temporarily: {
    kind: 'sync_temporary', status: 503, retryable: true, message: 'Eşitleme şu anda tamamlanamadı. Tekrar denenecek.',
  },

  // ── permanent operation failure ───────────────────────────────────────────
  operation_failed: { kind: 'operation_permanent', status: 500, retryable: false, message: 'İşlem tamamlanamadı.' },
  send_failed: { kind: 'operation_permanent', status: 422, retryable: false, message: 'İleti gönderilemedi.' },
  attachment_missing: {
    kind: 'operation_permanent', status: 422, retryable: false,
    message: 'Ek dosyası bulunamadı. Eki yeniden ekleyip gönderin.',
  },
  internal_error: { kind: 'operation_permanent', status: 500, retryable: false, message: 'Beklenmeyen bir hata oluştu.' },
} as const);

export type ApiErrorCode = keyof typeof ERROR_DEFINITIONS;
export const API_ERROR_CODES = Object.keys(ERROR_DEFINITIONS) as [ApiErrorCode, ...ApiErrorCode[]];

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

export const ApiErrorSchema = z
  .strictObject({
    code: ApiErrorCodeSchema,
    kind: z.enum(ERROR_KINDS),
    /** User-safe Turkish text. Never provider output. */
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    /** Correlates with server logs; the only diagnostic handle the browser gets. */
    requestId: z.string().min(1).max(128).optional(),
    /** Validation: which request fields are wrong (dotted field name + a stable reason). */
    fields: z.array(z.strictObject({ field: z.string().max(200), reason: z.string().max(100) })).max(50).optional(),
    /** `recipient_rejected` / `invalid_recipient`: the addresses concerned. */
    recipients: z.array(z.string().max(320)).max(100).optional(),
    /** `attachment_*`: the files concerned. */
    fileNames: z.array(z.string().max(255)).max(100).optional(),
    /** `rate_limited` / temporary failures. */
    retryAfterSeconds: z.number().int().min(0).max(86_400).optional(),
  })
  .refine((e) => ERROR_DEFINITIONS[e.code].kind === e.kind, { message: '`kind` does not belong to `code`', path: ['kind'] });
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Body of every non-2xx response. */
export const ApiErrorResponseSchema = z.strictObject({ error: ApiErrorSchema });
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export interface ApiErrorExtras {
  message?: string;
  requestId?: string;
  fields?: ApiError['fields'];
  recipients?: string[];
  fileNames?: string[];
  retryAfterSeconds?: number;
}

/** Builds an `ApiError` from a code; kind, retry policy and default message come from the definition table. */
export function createApiError(code: ApiErrorCode, extras: ApiErrorExtras = {}): ApiError {
  const def = ERROR_DEFINITIONS[code];
  const error: ApiError = {
    code,
    kind: def.kind,
    message: extras.message ?? def.message,
    retryable: def.retryable,
  };
  if (extras.requestId !== undefined) error.requestId = extras.requestId;
  if (extras.fields !== undefined) error.fields = extras.fields;
  if (extras.recipients !== undefined) error.recipients = extras.recipients;
  if (extras.fileNames !== undefined) error.fileNames = extras.fileNames;
  if (extras.retryAfterSeconds !== undefined) error.retryAfterSeconds = extras.retryAfterSeconds;
  return error;
}

/** HTTP status for a code (server side). */
export const httpStatusOf = (code: ApiErrorCode): number => ERROR_DEFINITIONS[code].status;

/** Client-side classification helper: does this error mean "the Kaydet session is gone"? */
// (`invalid_credentials` is a failed sign-in attempt, not a lost session.)
export const isSessionError = (error: Pick<ApiError, 'code'>): boolean =>
  error.code === 'not_authenticated' || error.code === 'session_expired';
