import { simpleParser } from 'mailparser';
import type { Attachment as ParsedAttachment, AddressObject } from 'mailparser';
import { buildPreview, htmlToPlain } from '@kaydet/domain';
import type { EmailAddressDTO } from '@kaydet/domain';
import type { HtmlSanitizer } from '../../application/ports/mail/html-sanitizer.ts';

export interface ParsedAttachmentInfo {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly isInline: boolean;
  readonly contentId: string | null;
  readonly partReference: string;
}

export interface ParsedMimeMessage {
  readonly subject: string;
  readonly from: EmailAddressDTO;
  readonly to: readonly EmailAddressDTO[];
  readonly cc: readonly EmailAddressDTO[];
  readonly bcc: readonly EmailAddressDTO[];
  readonly date: string;
  readonly messageIdHeader: string | null;
  readonly inReplyTo: string | null;
  readonly references: string | null;
  readonly textBody: string | null;
  readonly htmlBody: { content: string; sanitized: true } | null;
  readonly preview: string;
  readonly attachments: readonly ParsedAttachmentInfo[];
  readonly attachmentParts: Readonly<Record<string, string>>;
}

/**
 * Sanitizes untrusted attachment file names to prevent path traversal semantics (../, \, /, null bytes).
 */
export function sanitizeAttachmentFilename(rawName: string | null | undefined, fallbackIndex = 1): string {
  if (!rawName || typeof rawName !== 'string') {
    return `attachment-${fallbackIndex}.dat`;
  }
  // Strip null bytes and control characters
  // eslint-disable-next-line no-control-regex
  let clean = rawName.replace(/[\0-\x1F\x7F]/g, '');
  // Extract basename after any slash or backslash
  const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  if (lastSlash >= 0) {
    clean = clean.slice(lastSlash + 1);
  }
  // Collapse consecutive dots
  clean = clean.replace(/\.\.+/g, '.').trim();
  // Strip leading dots to prevent hidden unix files / relative escapes
  clean = clean.replace(/^\.+/, '');
  if (!clean || clean === '.') {
    return `attachment-${fallbackIndex}.dat`;
  }
  return clean.slice(0, 255);
}

function normalizeAddress(addr: { address?: string; name?: string } | undefined): EmailAddressDTO {
  return {
    email: (addr?.address ?? '').trim().toLowerCase(),
    name: (addr?.name ?? '').trim(),
  };
}

function extractAddresses(obj: AddressObject | AddressObject[] | undefined): EmailAddressDTO[] {
  if (!obj) return [];
  const list = Array.isArray(obj) ? obj : [obj];
  const result: EmailAddressDTO[] = [];
  for (const item of list) {
    if (item.value) {
      for (const val of item.value) {
        if (val.address) {
          result.push(normalizeAddress(val));
        }
      }
    }
  }
  return result;
}

export async function parseMimeMessage(
  source: Buffer | string,
  options: {
    sanitizer: HtmlSanitizer;
    generateId: () => string;
  },
): Promise<ParsedMimeMessage> {
  const parsed = await simpleParser(source);

  const fromAddresses = extractAddresses(parsed.from);
  const from: EmailAddressDTO = fromAddresses[0] ?? { email: '', name: '' };
  const to = extractAddresses(parsed.to);
  const cc = extractAddresses(parsed.cc);
  const bcc = extractAddresses(parsed.bcc);

  const subject = (parsed.subject ?? '').trim();
  const date = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();

  const messageIdHeader = parsed.messageId ? parsed.messageId.trim() : null;
  const inReplyTo = parsed.inReplyTo ? parsed.inReplyTo.trim() : null;
  const references = Array.isArray(parsed.references)
    ? parsed.references.join(' ')
    : typeof parsed.references === 'string'
      ? parsed.references.trim()
      : null;

  // Body extraction
  let rawText = parsed.text ? parsed.text : null;
  const rawHtml = parsed.html !== false && typeof parsed.html === 'string' && parsed.html.trim() !== '' ? parsed.html : null;

  // Fallback: if plain text is absent but HTML exists, extract plain text via domain htmlToPlain
  if (!rawText && rawHtml) {
    rawText = htmlToPlain(rawHtml);
  }

  // Preview generation
  const preview = buildPreview(rawText, 140);

  // HTML sanitization boundary:
  // ONLY pass through HtmlSanitizer and mark { sanitized: true }
  let htmlBody: { content: string; sanitized: true } | null = null;
  if (rawHtml) {
    const sanitizedContent = options.sanitizer.sanitize(rawHtml);
    htmlBody = {
      content: sanitizedContent,
      sanitized: true,
    };
  }

  // Attachments extraction
  const attachments: ParsedAttachmentInfo[] = [];
  const attachmentParts: Record<string, string> = {};

  if (parsed.attachments && parsed.attachments.length > 0) {
    let index = 1;
    for (const att of parsed.attachments as ParsedAttachment[]) {
      const id = options.generateId();
      const safeFilename = sanitizeAttachmentFilename(att.filename, index);
      const isInline = Boolean(att.related || att.contentDisposition === 'inline' || att.cid);
      const contentId = att.cid ? att.cid.replace(/^<|>$/g, '').trim() : null;
      const partRef = contentId ?? `part-${index}`;

      attachments.push({
        id,
        fileName: safeFilename,
        mimeType: att.contentType || 'application/octet-stream',
        sizeBytes: att.size || att.content?.length || 0,
        isInline,
        contentId,
        partReference: partRef,
      });

      attachmentParts[id] = partRef;
      index++;
    }
  }

  return {
    subject,
    from,
    to,
    cc,
    bcc,
    date,
    messageIdHeader,
    inReplyTo,
    references,
    textBody: rawText,
    htmlBody,
    preview,
    attachments,
    attachmentParts,
  };
}
