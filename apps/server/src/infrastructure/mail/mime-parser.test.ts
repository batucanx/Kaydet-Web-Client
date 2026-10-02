import { describe, expect, it } from 'vitest';
import { parseMimeMessage, sanitizeAttachmentFilename } from './mime-parser.ts';
import { SanitizeHtmlAdapter } from './sanitize-html-adapter.ts';

describe('mime-parser', () => {
  const sanitizer = new SanitizeHtmlAdapter();
  let idCounter = 1;
  const generateId = () => `att-${idCounter++}`;

  describe('sanitizeAttachmentFilename', () => {
    it('strips directory paths and traversal sequences', () => {
      expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd');
      expect(sanitizeAttachmentFilename('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
      expect(sanitizeAttachmentFilename('..\\..\\boot.ini')).toBe('boot.ini');
      expect(sanitizeAttachmentFilename('/var/mail/inbox.eml')).toBe('inbox.eml');
    });

    it('strips null bytes and control characters', () => {
      expect(sanitizeAttachmentFilename('file\0name.txt')).toBe('filename.txt');
      expect(sanitizeAttachmentFilename('\x01\x02test.pdf')).toBe('test.pdf');
    });

    it('handles empty, dots or whitespace safely', () => {
      expect(sanitizeAttachmentFilename('')).toBe('attachment-1.dat');
      expect(sanitizeAttachmentFilename('...')).toBe('attachment-1.dat');
      expect(sanitizeAttachmentFilename(null)).toBe('attachment-1.dat');
    });
  });

  describe('parseMimeMessage', () => {
    it('parses a basic text/plain email', async () => {
      const raw = [
        'From: "Sender Name" <sender@example.com>',
        'To: "Recipient" <recipient@example.com>',
        'Subject: Merhaba Dunya',
        'Date: Thu, 01 Oct 2026 12:00:00 +0300',
        'Message-ID: <msg123@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Bu bir test iletisidir.',
      ].join('\r\n');

      const result = await parseMimeMessage(Buffer.from(raw), { sanitizer, generateId });

      expect(result.subject).toBe('Merhaba Dunya');
      expect(result.from).toEqual({ email: 'sender@example.com', name: 'Sender Name' });
      expect(result.to).toEqual([{ email: 'recipient@example.com', name: 'Recipient' }]);
      expect(result.messageIdHeader).toBe('<msg123@example.com>');
      expect(result.textBody).toContain('Bu bir test iletisidir.');
      expect(result.htmlBody).toBeNull();
      expect(result.preview).toBe('Bu bir test iletisidir.');
    });

    it('parses multipart/alternative with HTML and sanitizes it', async () => {
      const boundary = '----=_Part_0_123456789';
      const raw = [
        'From: Ahmet <ahmet@example.com>',
        'To: Mehmet <mehmet@example.com>',
        'Subject: =?UTF-8?Q?Toplant=C4=B1_Hakk=C4=B1nda?=',
        'Content-Type: multipart/alternative; boundary="' + boundary + '"',
        '',
        '--' + boundary,
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Toplanti saat 14:00te.',
        '--' + boundary,
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Toplanti saat <b>14:00</b>te.</p><script>alert("xss")</script>',
        '--' + boundary + '--',
      ].join('\r\n');

      const result = await parseMimeMessage(Buffer.from(raw), { sanitizer, generateId });

      expect(result.subject).toBe('Toplantı Hakkında');
      expect(result.textBody).toContain('Toplanti saat 14:00te.');
      expect(result.htmlBody).not.toBeNull();
      expect(result.htmlBody?.sanitized).toBe(true);
      expect(result.htmlBody?.content).toContain('<b>14:00</b>');
      expect(result.htmlBody?.content).not.toContain('<script');
    });

    it('extracts attachment metadata and prevents path traversal in attachment names', async () => {
      const boundary = '----=_Part_Mixed_987654';
      const raw = [
        'From: report@example.com',
        'To: batuhan@example.com',
        'Subject: Rapor',
        'Content-Type: multipart/mixed; boundary="' + boundary + '"',
        '',
        '--' + boundary,
        'Content-Type: text/plain',
        '',
        'Ekli dosyayi inceleyiniz.',
        '--' + boundary,
        'Content-Type: application/pdf; name="../../secret/rapor.pdf"',
        'Content-Disposition: attachment; filename="../../secret/rapor.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('PDF_DUMMY_CONTENT').toString('base64'),
        '--' + boundary + '--',
      ].join('\r\n');

      const result = await parseMimeMessage(Buffer.from(raw), { sanitizer, generateId });

      expect(result.attachments).toHaveLength(1);
      const att = result.attachments[0]!;
      expect(att.fileName).toBe('rapor.pdf');
      expect(att.mimeType).toBe('application/pdf');
      expect(att.isInline).toBe(false);
      expect(att.sizeBytes).toBeGreaterThan(0);
      expect(result.attachmentParts[att.id]).toBeDefined();
    });

    it('handles threading headers: In-Reply-To and References', async () => {
      const raw = [
        'From: a@example.com',
        'To: b@example.com',
        'Subject: Re: Test',
        'Message-ID: <reply456@example.com>',
        'In-Reply-To: <original123@example.com>',
        'References: <thread0@example.com> <original123@example.com>',
        'Content-Type: text/plain',
        '',
        'Anladim.',
      ].join('\r\n');

      const result = await parseMimeMessage(Buffer.from(raw), { sanitizer, generateId });

      expect(result.messageIdHeader).toBe('<reply456@example.com>');
      expect(result.inReplyTo).toBe('<original123@example.com>');
      expect(result.references).toBe('<thread0@example.com> <original123@example.com>');
    });
  });
});
