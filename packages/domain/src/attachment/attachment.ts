/**
 * Attachment classification, upload policy and size formatting.
 *
 * SOURCE: mobile `lib/domain/use_cases/attachment_type.dart` (`AttachmentType`, `AttachmentKind`),
 *         `share_attachment_policy.dart` (`ShareAttachmentPolicy`) and `lib/core/date_format.dart`
 *         (`formatBytes`).
 * PURPOSE: One decision about what an attachment IS (preview/icon behaviour) and whether a file may be
 *          attached at all. MIME type and extension are combined because servers do not always send a
 *          correct `Content-Type` while the extension is always present. Source-like formats (HTML, SVG,
 *          XML…) are `text`: shown as raw text, never rendered, because rendering an HTML/SVG attachment
 *          could run its scripts. Executables/installers are `executable`: no preview, save only.
 * WEB USAGE: attachment chips/icons/preview routing in the client, and server-side enforcement on upload
 *            (the same rule, so a hostile client cannot bypass the browser check).
 */

export const ATTACHMENT_KINDS = [
  'pdf', 'image', 'text', 'document', 'spreadsheet', 'presentation', 'archive', 'audio', 'video',
  'executable', 'unknown',
] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * Executable/installer types every major provider rejects (mobile `blockedExtensions`). The last
 * extension decides, so `fatura.pdf.exe` is caught.
 */
export const BLOCKED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ade', '.adp', '.apk', '.appx', '.appxbundle', '.bat', '.cab', '.chm',
  '.cmd', '.com', '.cpl', '.dll', '.dmg', '.exe', '.hta', '.ins', '.iso',
  '.isp', '.jar', '.jse', '.lib', '.lnk', '.mde', '.msc', '.msi', '.msix',
  '.msixbundle', '.msp', '.mst', '.pif', '.ps1', '.scr', '.sct', '.shb',
  '.sys', '.vb', '.vbe', '.vbs', '.vxd', '.wsc', '.wsf', '.wsh',
]);

/** Most servers stop at 25 MB (about 33 MB after base64), so a single file is capped there. */
export const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;
/** Total of all files of one message. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;

const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp']);
const DOCUMENT = new Set(['.doc', '.docx', '.odt', '.rtf']);
const SPREADSHEET = new Set(['.xls', '.xlsx', '.csv', '.ods']);
const PRESENTATION = new Set(['.ppt', '.pptx', '.odp']);
const ARCHIVE = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz']);
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
const VIDEO = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
/** Source/text formats, shown as raw text. CSV is NOT here: to the user it is a spreadsheet. */
const TEXT = new Set([
  '.txt', '.json', '.xml', '.html', '.htm', '.svg', '.css', '.js', '.ts', '.dart', '.java', '.py',
  '.c', '.cpp', '.h', '.md', '.yaml', '.yml', '.log',
]);

const WORD_MIMES = new Set([
  'application/msword',
  'application/rtf',
  'text/rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/vnd.oasis.opendocument.text',
]);
const SHEET_MIMES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  'application/vnd.oasis.opendocument.spreadsheet',
]);
const SLIDE_MIMES = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
]);
const ARCHIVE_MIMES = new Set([
  'application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed', 'application/x-tar',
  'application/gzip',
]);

/** Lower-cased extension including the dot, `''` for none (`.bashrc` has none; `a.tar.gz` → `.gz`). */
export function fileExtension(fileName: string): string {
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** Coarse kind from MIME type + file name (mobile `AttachmentType.resolve`). Extension wins over MIME. */
export function classifyAttachment(input: { mimeType: string; fileName: string }): AttachmentKind {
  const ext = fileExtension(input.fileName);
  if (BLOCKED_ATTACHMENT_EXTENSIONS.has(ext)) return 'executable';

  // Content-Type may carry parameters (`; name=…`); decide on the bare MIME type.
  const mime = (input.mimeType.toLowerCase().split(';')[0] ?? '').trim();

  // Some servers send text/csv, but to the user a CSV is a spreadsheet.
  if (ext === '.csv') return 'spreadsheet';
  if (TEXT.has(ext)) return 'text';
  if (IMAGE.has(ext)) return 'image';
  if (DOCUMENT.has(ext)) return 'document';
  if (SPREADSHEET.has(ext)) return 'spreadsheet';
  if (PRESENTATION.has(ext)) return 'presentation';
  if (ARCHIVE.has(ext)) return 'archive';
  if (AUDIO.has(ext)) return 'audio';
  if (VIDEO.has(ext)) return 'video';

  // Unknown extension: fall back to the MIME type (e.g. an extension-less attachment with a correct type).
  if (mime === 'application/pdf') return 'pdf';
  if (WORD_MIMES.has(mime)) return 'document';
  if (SHEET_MIMES.has(mime)) return 'spreadsheet';
  if (SLIDE_MIMES.has(mime)) return 'presentation';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/')) return 'text';
  if (ARCHIVE_MIMES.has(mime)) return 'archive';

  if (ext === '.pdf') return 'pdf';
  return 'unknown';
}

/** Short type label for a card: `PDF`, `XML`, `DOCX`; `DOSYA` when there is no extension. */
export function attachmentTypeLabel(fileName: string): string {
  const ext = fileExtension(fileName);
  return ext === '' ? 'DOSYA' : ext.slice(1).toUpperCase();
}

export type AttachmentRejection = 'blocked_type' | 'empty' | 'too_large';

/** Why a single file may not be attached; `null` when it can be. */
export function attachmentRejection(input: { fileName: string; sizeBytes: number }): AttachmentRejection | null {
  if (BLOCKED_ATTACHMENT_EXTENSIONS.has(fileExtension(input.fileName))) return 'blocked_type';
  if (input.sizeBytes <= 0) return 'empty';
  if (input.sizeBytes > MAX_ATTACHMENT_FILE_BYTES) return 'too_large';
  return null;
}

export interface AttachmentIssue {
  readonly code: AttachmentRejection;
  readonly fileName?: string | undefined;
}

/**
 * One user-facing sentence, summarising when several files were rejected; `null` when nothing was
 * rejected. Text is mobile's (`ShareAttachmentPolicy.describe`).
 */
export function describeAttachmentIssues(issues: readonly AttachmentIssue[]): string | null {
  if (issues.length === 0) return null;
  if (issues.length === 1) {
    const issue = issues[0] as AttachmentIssue;
    const name = issue.fileName === undefined ? 'Dosya' : `“${issue.fileName}”`;
    switch (issue.code) {
      case 'too_large':
        return `${name} çok büyük (en fazla ${MAX_ATTACHMENT_FILE_BYTES >> 20} MB) ve eklenmedi.`;
      case 'blocked_type':
        return `${name} güvenlik nedeniyle e-postaya eklenemez.`;
      case 'empty':
        return `${name} boş olduğu için eklenmedi.`;
    }
  }
  return `${issues.length} dosya eklenemedi (çok büyük, desteklenmeyen ya da okunamayan dosyalar).`;
}

/** File size with a Turkish decimal comma: `512 B`, `1,5 KB`, `3,0 MB`, `14 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded.replace('.', ',')} ${units[unit]}`;
}
