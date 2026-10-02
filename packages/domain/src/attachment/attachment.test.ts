import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_FILE_BYTES,
  attachmentRejection,
  attachmentTypeLabel,
  classifyAttachment,
  describeAttachmentIssues,
  fileExtension,
  formatBytes,
} from './attachment.ts';

const kind = (fileName: string, mimeType = 'application/octet-stream') => classifyAttachment({ fileName, mimeType });

describe('fileExtension', () => {
  it('takes the last extension, lower-cased', () => {
    expect(fileExtension('Rapor.PDF')).toBe('.pdf');
    expect(fileExtension('arsiv.tar.gz')).toBe('.gz');
    expect(fileExtension('fatura.pdf.exe')).toBe('.exe');
  });
  it('has none for dotfiles, bare names and dotless paths', () => {
    expect(fileExtension('.bashrc')).toBe('');
    expect(fileExtension('dosya')).toBe('');
    expect(fileExtension('klasor.v2/dosya')).toBe('');
    expect(fileExtension('C:\\a.b\\dosya')).toBe('');
  });
});

describe('classifyAttachment (mobile attachment_icon_test.dart / docx_and_spreadsheet_preview_test.dart)', () => {
  it('routes by extension', () => {
    expect(kind('a.pdf')).toBe('pdf');
    expect(kind('a.PNG')).toBe('image');
    expect(kind('a.heic')).toBe('image');
    expect(kind('a.docx')).toBe('document');
    expect(kind('a.xlsx')).toBe('spreadsheet');
    expect(kind('a.pptx')).toBe('presentation');
    expect(kind('a.zip')).toBe('archive');
    expect(kind('a.mp3')).toBe('audio');
    expect(kind('a.mp4')).toBe('video');
    expect(kind('a.dart')).toBe('text');
  });

  it('CSV is a spreadsheet even when the server says text/csv', () => {
    expect(kind('veri.csv', 'text/csv')).toBe('spreadsheet');
  });

  it('HTML/SVG/XML attachments are raw text, never rendered content', () => {
    expect(kind('a.html', 'text/html')).toBe('text');
    expect(kind('a.svg', 'image/svg+xml')).toBe('text');
    expect(kind('a.xml', 'application/xml')).toBe('text');
  });

  it('executables are blocked, also behind a double extension', () => {
    expect(kind('kurulum.exe')).toBe('executable');
    expect(kind('fatura.pdf.exe', 'application/pdf')).toBe('executable');
    expect(kind('a.SCR')).toBe('executable');
  });

  it('falls back to the MIME type when the extension is unknown or missing', () => {
    expect(kind('dosya', 'application/pdf')).toBe('pdf');
    expect(kind('dosya', 'image/png')).toBe('image');
    expect(kind('dosya', 'audio/mpeg')).toBe('audio');
    expect(kind('dosya', 'video/mp4')).toBe('video');
    expect(kind('dosya', 'text/plain')).toBe('text');
    expect(kind('dosya', 'application/zip')).toBe('archive');
  });

  it('routes extension-less Office attachments, tolerating Content-Type parameters', () => {
    expect(
      kind('dosya', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document; name=dosya'),
    ).toBe('document');
    expect(kind('ek', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('spreadsheet');
    expect(kind('sunum', 'application/vnd.ms-powerpoint')).toBe('presentation');
  });

  it('an extension beats a contradicting MIME type', () => {
    expect(kind('a.png', 'application/pdf')).toBe('image');
  });

  it('a .pdf name with an odd MIME still resolves to pdf', () => {
    expect(kind('a.pdf', 'application/octet-stream')).toBe('pdf');
  });

  it('unknown stays unknown', () => {
    expect(kind('a.xyz')).toBe('unknown');
    expect(kind('dosya')).toBe('unknown');
  });
});

describe('attachmentTypeLabel', () => {
  it('upper-cases the extension; DOSYA without one', () => {
    expect(attachmentTypeLabel('Rapor.pdf')).toBe('PDF');
    expect(attachmentTypeLabel('a.docx')).toBe('DOCX');
    expect(attachmentTypeLabel('dosya')).toBe('DOSYA');
  });
});

describe('attachmentRejection / describeAttachmentIssues', () => {
  it('rejects blocked types, empty and oversize files', () => {
    expect(attachmentRejection({ fileName: 'a.exe', sizeBytes: 10 })).toBe('blocked_type');
    expect(attachmentRejection({ fileName: 'a.pdf', sizeBytes: 0 })).toBe('empty');
    expect(attachmentRejection({ fileName: 'a.pdf', sizeBytes: MAX_ATTACHMENT_FILE_BYTES + 1 })).toBe('too_large');
  });
  it('accepts a file exactly at the limit', () => {
    expect(attachmentRejection({ fileName: 'a.pdf', sizeBytes: MAX_ATTACHMENT_FILE_BYTES })).toBeNull();
  });
  it('blocked type wins over size', () => {
    expect(attachmentRejection({ fileName: 'a.exe', sizeBytes: MAX_ATTACHMENT_FILE_BYTES * 2 })).toBe('blocked_type');
  });

  it('describes a single issue with the mobile wording', () => {
    expect(describeAttachmentIssues([{ code: 'too_large', fileName: 'a.zip' }])).toBe(
      '“a.zip” çok büyük (en fazla 25 MB) ve eklenmedi.',
    );
    expect(describeAttachmentIssues([{ code: 'blocked_type', fileName: 'a.exe' }])).toBe(
      '“a.exe” güvenlik nedeniyle e-postaya eklenemez.',
    );
    expect(describeAttachmentIssues([{ code: 'empty' }])).toBe('Dosya boş olduğu için eklenmedi.');
  });
  it('summarises several issues; nothing for none', () => {
    expect(describeAttachmentIssues([{ code: 'empty' }, { code: 'too_large' }])).toBe(
      '2 dosya eklenemedi (çok büyük, desteklenmeyen ya da okunamayan dosyalar).',
    );
    expect(describeAttachmentIssues([])).toBeNull();
  });
});

describe('formatBytes (mobile text_and_models_test.dart)', () => {
  it('uses a Turkish decimal comma and unit steps', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1,5 KB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3,0 MB');
    expect(formatBytes(1024 * 1024 * 14.4)).toBe('14 MB');
    expect(formatBytes(1024 ** 3 * 2)).toBe('2,0 GB');
  });
  it('never goes past TB', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024 TB');
  });
});
