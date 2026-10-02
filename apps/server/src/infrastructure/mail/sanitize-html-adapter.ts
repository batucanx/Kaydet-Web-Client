import sanitizeHtml from 'sanitize-html';
import type { HtmlSanitizer } from '../../application/ports/mail/html-sanitizer.ts';

/**
 * Production implementation of HtmlSanitizer using sanitize-html.
 * Enforces email safety: strips all executable content, event handlers, scripts,
 * forms, dangerous URI schemes, while preserving email formatting and inline images (cid:).
 */
export class SanitizeHtmlAdapter implements HtmlSanitizer {
  private readonly options: sanitizeHtml.IOptions;

  constructor() {
    this.options = {
      allowedTags: [
        'a', 'abbr', 'acronym', 'address', 'b', 'bdo', 'big', 'blockquote', 'br',
        'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'dfn',
        'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
        'i', 'img', 'ins', 'kbd', 'li', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small',
        'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot',
        'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
      ],
      allowedAttributes: {
        a: ['href', 'name', 'target', 'title', 'rel'],
        img: ['src', 'alt', 'title', 'width', 'height', 'align', 'border'],
        font: ['color', 'size', 'face'],
        table: ['align', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'width', 'height'],
        tr: ['align', 'valign', 'bgcolor'],
        td: ['align', 'valign', 'bgcolor', 'width', 'height', 'colspan', 'rowspan'],
        th: ['align', 'valign', 'bgcolor', 'width', 'height', 'colspan', 'rowspan'],
        col: ['width', 'span', 'align', 'valign'],
        colgroup: ['width', 'span', 'align', 'valign'],
        '*': ['style', 'dir', 'lang', 'title'],
      },
      allowedSchemes: ['http', 'https', 'mailto', 'cid'],
      allowedSchemesByTag: {
        img: ['http', 'https', 'cid'],
        a: ['http', 'https', 'mailto'],
      },
      allowProtocolRelative: false,
      transformTags: {
        a: (tagName, attribs) => {
          // Force target="_blank" and rel="noopener noreferrer" on external links
          const newAttribs = { ...attribs };
          if (newAttribs.href && (newAttribs.href.startsWith('http://') || newAttribs.href.startsWith('https://'))) {
            newAttribs.target = '_blank';
            newAttribs.rel = 'noopener noreferrer';
          }
          return { tagName, attribs: newAttribs };
        },
      },
    };
  }

  sanitize(untrustedHtml: string): string {
    if (typeof untrustedHtml !== 'string' || untrustedHtml.trim() === '') {
      return '';
    }
    return sanitizeHtml(untrustedHtml, this.options);
  }
}
