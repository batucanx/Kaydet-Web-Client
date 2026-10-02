/**
 * Signature formatting, rendering, and DOM manipulation helpers.
 *
 * CRITICAL REGRESSION RULE:
 * Signatures containing images (e.g. PNG base64, URLs, formatting) must render
 * their exact HTML representation in:
 * - Initial compose
 * - Reply
 * - Forward
 * - Manual signature selection / replacement
 * - Draft reload
 * - Send (bodyHtml)
 * Image signatures must NEVER be converted to plain text.
 */

const SIGNATURE_CONTAINER_ATTR = 'data-signature="true"';
const SIGNATURE_REGEX = /<div[^>]*\bdata-signature="true"[^>]*>[\s\S]*?<\/div>/i;

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

import type { SignatureDTO } from '@kaydet/domain';

/**
 * Checks whether a signature body contains HTML markup.
 */
export function isHtmlContent(content: string): boolean {
  return /<[a-z][\s\S]*>/i.test(content);
}

/**
 * Formats signature body into wrapped HTML suitable for the compose editor.
 * If HTML is detected (such as <img ...>), the tags are preserved as-is.
 * Plain text is converted to safe HTML with <br/> line breaks.
 */
export function renderSignatureHtml(
  signatureOrBody: SignatureDTO | string,
  signatureId?: string
): string {
  const body = typeof signatureOrBody === 'string' ? signatureOrBody : signatureOrBody.body;
  const id = typeof signatureOrBody === 'string' ? signatureId : signatureOrBody.id;
  if (!body.trim()) return '';

  const idAttr = id ? ` data-signature-id="${escapeHtml(id)}"` : '';
  const innerHtml = isHtmlContent(body)
    ? body
    : body.split('\n').map(escapeHtml).join('<br/>');

  return `<div class="kaydet-signature" ${SIGNATURE_CONTAINER_ATTR}${idAttr}>${innerHtml}</div>`;
}

/**
 * Replaces or removes an existing signature inside an HTML body, or appends it.
 * If newSignature is null, any existing signature block is removed.
 * Uses DOMParser when available to guarantee that nested HTML elements (like images or tables)
 * are cleanly handled without regex truncation.
 */
export function updateBodySignature(
  currentHtml: string,
  newSignature: SignatureDTO | string | null
): string {
  const newSignatureHtml =
    newSignature === null
      ? null
      : typeof newSignature === 'string'
      ? (newSignature.includes(SIGNATURE_CONTAINER_ATTR) ? newSignature : renderSignatureHtml(newSignature))
      : renderSignatureHtml(newSignature);

  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(currentHtml, 'text/html');
    const existing = doc.body.querySelector('[data-signature="true"]');

    if (newSignatureHtml) {
      const template = doc.createElement('template');
      template.innerHTML = newSignatureHtml;
      const newEl = template.content.firstElementChild;
      if (existing && newEl) {
        existing.replaceWith(newEl);
      } else if (newEl) {
        const quoteEl = doc.body.querySelector('.quote-header, .kaydet-quote');
        if (quoteEl) {
          doc.body.insertBefore(newEl, quoteEl);
        } else {
          doc.body.appendChild(newEl);
        }
      }
    } else {
      if (existing) {
        existing.remove();
      }
    }
    return doc.body.innerHTML;
  }

  const hasExisting = SIGNATURE_REGEX.test(currentHtml);

  if (hasExisting) {
    if (newSignatureHtml) {
      return currentHtml.replace(SIGNATURE_REGEX, newSignatureHtml);
    }
    // Remove existing signature and clean up trailing empty breaks
    return currentHtml.replace(SIGNATURE_REGEX, '').replace(/<p><br\s*\/?><\/p>\s*$/i, '');
  }

  if (!newSignatureHtml) {
    return currentHtml;
  }

  // Append signature with a spacing paragraph if needed
  const trimmed = currentHtml.trim();
  if (!trimmed || trimmed === '<p><br></p>') {
    return `<p><br></p>${newSignatureHtml}`;
  }
  return `${currentHtml}<p><br></p>${newSignatureHtml}`;
}

/**
 * Extracts signature id attribute from html body if present.
 */
export function extractSignatureIdFromHtml(html: string): string | null {
  const match = html.match(/data-signature-id="([^"]+)"/i);
  return match ? match[1] : null;
}

/**
 * Extracts plain text from editor HTML while preserving logical line breaks.
 */
export function htmlToBodyText(html: string): string {
  if (!html) return '';

  // Use DOMParser if available in browser
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.innerText || doc.body.textContent || '';
  }

  // Server/test fallback
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}
