/**
 * Attachment download responses. Attachment bytes and their declared MIME type come from mail: untrusted.
 *
 *  - Only a short allow-list of passive types may be shown inline; everything else (executables, HTML, SVG, XML,
 *    scripts, unknown types) is forced to `Content-Disposition: attachment`, and source-like types are also
 *    served as `application/octet-stream` so a browser can never execute or render them from our origin.
 *  - `X-Content-Type-Options: nosniff` always; a `sandbox` CSP on everything except PDF.
 *  - The file name is sanitised for the header (no path separators, control characters or quotes).
 */
import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import type { AttachmentDownload } from '../../application/index.ts';

const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain)$/i;
const SOURCE_LIKE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|(text|application)\/xml|(text|application)\/(x-)?javascript)$/i;
const MIME_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export function safeAttachmentName(fileName: string): string {
  const cleaned = fileName
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim();
  return cleaned === '' ? 'attachment' : cleaned.slice(0, 255);
}

export function contentDisposition(fileName: string, inline: boolean): string {
  const name = safeAttachmentName(fileName);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function sendAttachment(reply: FastifyReply, file: AttachmentDownload, forceDownload: boolean): FastifyReply {
  const declared = MIME_SHAPE.test(file.mimeType) ? file.mimeType.toLowerCase() : 'application/octet-stream';
  const inline = !forceDownload && INLINE_SAFE.test(declared);
  const contentType = SOURCE_LIKE.test(declared) ? 'application/octet-stream' : declared;
  void reply
    .header('content-type', contentType)
    .header('content-length', String(file.sizeBytes))
    .header('content-disposition', contentDisposition(file.fileName, inline))
    .header('x-content-type-options', 'nosniff');
  if (declared !== 'application/pdf') void reply.header('content-security-policy', "default-src 'none'; sandbox");
  return reply.code(200).send(Readable.from(file.stream));
}
