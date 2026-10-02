import { describe, expect, it } from 'vitest';
import { mapImapFlags, mapImapMailboxToStoredFolder } from './imap-mapping.ts';
import { normalizeImapError } from './imap-errors.ts';

describe('imap-mapping', () => {
  describe('mapImapMailboxToStoredFolder', () => {
    it('maps special-use flag directly to system role', () => {
      const folder = mapImapMailboxToStoredFolder('f1', {
        path: 'CustomSentBox',
        delimiter: '/',
        specialUse: '\\Sent',
      });
      expect(folder.role).toBe('sent');
      expect(folder.name).toBe('Gönderilenler');
      expect(folder.sortOrder).toBe(10);
    });

    it('maps INBOX to inbox role with Turkish display name', () => {
      const folder = mapImapMailboxToStoredFolder('f2', {
        path: 'INBOX',
        delimiter: '.',
      });
      expect(folder.role).toBe('inbox');
      expect(folder.name).toBe('Gelen Kutusu');
      expect(folder.sortOrder).toBe(0);
    });

    it('maps Turkish provider folder names (Gonderilenler, Cop, etc.)', () => {
      const sentFolder = mapImapMailboxToStoredFolder('f3', {
        path: 'INBOX/Gonderilmis Ogeler',
        delimiter: '/',
      });
      expect(sentFolder.role).toBe('sent');
      expect(sentFolder.name).toBe('Gönderilenler');

      const trashFolder = mapImapMailboxToStoredFolder('f4', {
        path: 'Cop Kutusu',
        delimiter: '/',
      });
      expect(trashFolder.role).toBe('trash');
      expect(trashFolder.name).toBe('Çöp Kutusu');
    });

    it('maps custom folders keeping their original leaf name', () => {
      const custom = mapImapMailboxToStoredFolder('f5', {
        path: 'Projeler/Kaydet',
        delimiter: '/',
      });
      expect(custom.role).toBe('custom');
      expect(custom.name).toBe('Kaydet');
      expect(custom.sortOrder).toBe(100);
      expect(custom.provider.path).toBe('Projeler/Kaydet');
    });

    it('preserves UIDVALIDITY and MODSEQ metadata', () => {
      const folder = mapImapMailboxToStoredFolder('f6', {
        path: 'INBOX',
        uidValidity: 12345,
        uidNext: 50,
        highestModseq: 9999n,
      });
      expect(folder.provider.uidValidity).toBe(12345);
      expect(folder.provider.uidNext).toBe(50);
      expect(folder.provider.highestModSeq).toBe(9999);
    });
  });

  describe('mapImapFlags', () => {
    it('maps standard IMAP flags correctly', () => {
      const flags = new Set(['\\Seen', '\\Flagged', '\\Answered']);
      const mapped = mapImapFlags(flags);
      expect(mapped.seen).toBe(true);
      expect(mapped.pinned).toBe(true); // \Flagged maps to pinned
      expect(mapped.answered).toBe(true);
      expect(mapped.draft).toBe(false);
      expect(mapped.serverDeleted).toBe(false);
    });

    it('maps deleted flag and forwarded keyword', () => {
      const flags = ['\\Deleted', '$Forwarded'];
      const mapped = mapImapFlags(flags);
      expect(mapped.serverDeleted).toBe(true);
      expect(mapped.forwarded).toBe(true);
    });

    it('extracts custom kaydet_ keywords', () => {
      const flags = ['\\Seen', 'kaydet_fatura', 'kaydet_onemli', 'unrelated_flag'];
      const mapped = mapImapFlags(flags);
      expect(mapped.customLabels).toEqual(['kaydet_fatura', 'kaydet_onemli']);
    });
  });

  describe('normalizeImapError', () => {
    it('normalizes authentication failures to mail_credentials_rejected', () => {
      const err = { responseStatus: 'NO', responseText: '[AUTHENTICATIONFAILED] Invalid credentials' };
      const normalized = normalizeImapError(err);
      expect(normalized.code).toBe('mail_credentials_rejected');
    });

    it('normalizes TLS certificate errors to provider_tls_failed', () => {
      const err = { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' };
      const normalized = normalizeImapError(err);
      expect(normalized.code).toBe('provider_tls_failed');
    });

    it('normalizes connection errors to provider_unreachable', () => {
      const err = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:993' };
      const normalized = normalizeImapError(err);
      expect(normalized.code).toBe('provider_unreachable');
    });

    it('normalizes missing mailbox to provider_mailbox_missing', () => {
      const err = { responseStatus: 'NO', responseText: '[NONEXISTENT] Mailbox does not exist' };
      const normalized = normalizeImapError(err);
      expect(normalized.code).toBe('provider_mailbox_missing');
    });

    it('normalizes quota exceeded to quota_exceeded', () => {
      const err = { responseText: '[OVERQUOTA] Storage limit exceeded' };
      const normalized = normalizeImapError(err);
      expect(normalized.code).toBe('quota_exceeded');
    });
  });
});
