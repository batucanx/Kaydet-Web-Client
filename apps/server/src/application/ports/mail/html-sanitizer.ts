/**
 * Port for server-side email HTML sanitization.
 *
 * Decision D2: Email HTML is untrusted input. The server sanitizes HTML before storing and
 * returning it through API DTOs. `sanitized: true` is only valid after passing through this port.
 */

export interface HtmlSanitizer {
  /**
   * Sanitizes untrusted email HTML into browser-safe HTML.
   * Strips scripts, executable objects, forms, and dangerous event handlers.
   */
  sanitize(untrustedHtml: string): string;
}
