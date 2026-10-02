import { describe, expect, it } from 'vitest';
import {
  buildComposeStart,
  checkBeforeSend,
  type ComposeSource,
  type SignatureDTO,
} from '@kaydet/domain';
import {
  renderSignatureHtml,
  updateBodySignature,
  extractSignatureIdFromHtml,
} from './signatureUtils';

describe('Compose & Draft & Send - Critical Regressions & Logic', () => {
  describe('Signature Image Preservation', () => {
    const IMAGE_SIGNATURE: SignatureDTO = {
      id: 'sig-img-1',
      accountId: 'acc-1',
      name: 'Logo Signature',
      isDefault: true,
      body: '<p>Saygılarımla,<br/><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" alt="Company Logo" width="120" /></p>',
    };

    it('renders and preserves img tag and signature metadata when converted to HTML', () => {
      const html = renderSignatureHtml(IMAGE_SIGNATURE);

      expect(html).toContain('data-signature="true"');
      expect(html).toContain('data-signature-id="sig-img-1"');
      expect(html).toContain('<img src="data:image/png;base64,');
      expect(html).toContain('alt="Company Logo"');
    });

    it('preserves signature image when replacing or switching signatures in editor body', () => {
      const initialUserText = '<p>Merhaba Sayın Yetkili,</p><p>Konu hakkında bilgi almak istedim.</p>';
      const initialSigHtml = renderSignatureHtml(IMAGE_SIGNATURE);
      const initialBody = `${initialUserText}<br/>${initialSigHtml}`;

      // Verify initial signature has img and id
      expect(extractSignatureIdFromHtml(initialBody)).toBe('sig-img-1');
      expect(initialBody).toContain('<img src="data:image/png;base64,');

      // Now switch to another signature that also has an image
      const newImageSig: SignatureDTO = {
        id: 'sig-img-2',
        accountId: 'acc-1',
        name: 'Personal Signoff',
        isDefault: false,
        body: '<div>Batuhan<br/><img src="https://example.com/batuhan-sign.png" alt="Signature" /></div>',
      };

      const updatedBody = updateBodySignature(initialBody, newImageSig);

      // User text must still be intact
      expect(updatedBody).toContain('Merhaba Sayın Yetkili,');
      expect(updatedBody).toContain('Konu hakkında bilgi almak istedim.');
      // New signature must have its image and metadata
      expect(extractSignatureIdFromHtml(updatedBody)).toBe('sig-img-2');
      expect(updatedBody).toContain('https://example.com/batuhan-sign.png');
      expect(updatedBody).not.toContain('sig-img-1');
    });

    it('removes signature block cleanly when switched to null', () => {
      const initialUserText = '<p>Kısa not.</p>';
      const sigHtml = renderSignatureHtml(IMAGE_SIGNATURE);
      const bodyWithSig = `${initialUserText}<br/>${sigHtml}`;

      const clearedBody = updateBodySignature(bodyWithSig, null);

      expect(clearedBody).toContain('Kısa not.');
      expect(clearedBody).not.toContain('data-signature="true"');
      expect(extractSignatureIdFromHtml(clearedBody)).toBeNull();
    });

    it('initial compose state includes exact image tag without converting to plain text', () => {
      // Simulate initial blank compose with default image signature
      const sigHtml = renderSignatureHtml(IMAGE_SIGNATURE);
      const initialComposeHtml = `<p><br></p>${sigHtml}`;

      expect(initialComposeHtml).toContain('<img src="data:image/png;base64,');
      expect(initialComposeHtml).toContain('data-signature="true"');
      expect(extractSignatureIdFromHtml(initialComposeHtml)).toBe('sig-img-1');
    });

    it('reply initial state preserves image signature and places quote header after signature', () => {
      const sigHtml = renderSignatureHtml(IMAGE_SIGNATURE);
      const quoteText = '15 Eyl 2026 tarihinde Sender <sender@test.com> yazdı:\n> Orijinal mesaj';
      const quoteHtml = `<div class="quote-header">${quoteText.replace(/\n/g, '<br/>')}</div>`;
      const replyInitialHtml = `<p><br></p>${sigHtml}${quoteHtml}`;

      expect(replyInitialHtml).toContain('<img src="data:image/png;base64,');
      expect(replyInitialHtml).toContain('data-signature="true"');
      expect(replyInitialHtml).toContain('class="quote-header"');
      // Signature comes before quote block
      const sigIndex = replyInitialHtml.indexOf('data-signature="true"');
      const quoteIndex = replyInitialHtml.indexOf('class="quote-header"');
      expect(sigIndex).toBeLessThan(quoteIndex);
    });
  });

  describe('Recipient Validation (checkBeforeSend)', () => {
    it('blocks send when To recipients are empty', () => {
      const check = checkBeforeSend({
        to: [],
        cc: [{ email: 'cc@example.com' }],
        bcc: [],
        subject: 'Test Konu',
        bodyText: 'İçerik',
        hasAttachments: false,
        isReplyOrForward: false,
      });

      expect(check.blocker).toEqual({ code: 'no_recipients' });
    });

    it('blocks send when any recipient has an invalid email format', () => {
      const check = checkBeforeSend({
        to: [{ email: 'valid@example.com' }],
        cc: [{ email: 'not-an-email' }],
        bcc: [],
        subject: 'Test Konu',
        bodyText: 'İçerik',
        hasAttachments: false,
        isReplyOrForward: false,
      });

      expect(check.blocker).toEqual({
        code: 'invalid_address',
        address: 'not-an-email',
      });
    });

    it('warns about missing attachment when text mentions attachment and none is attached', () => {
      const check = checkBeforeSend({
        to: [{ email: 'valid@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Rapor',
        bodyText: 'Rapor detayları ekte sunulmuştur, inceleyebilirsiniz.',
        hasAttachments: false,
        isReplyOrForward: false,
      });

      expect(check.blocker).toBeNull();
      expect(check.confirmations).toContain('missing_attachment');
    });

    it('warns about empty subject', () => {
      const check = checkBeforeSend({
        to: [{ email: 'valid@example.com' }],
        cc: [],
        bcc: [],
        subject: '   ',
        bodyText: 'Merhaba dünya',
        hasAttachments: false,
        isReplyOrForward: false,
      });

      expect(check.blocker).toBeNull();
      expect(check.confirmations).toContain('empty_subject');
    });

    it('allows clean send without warnings when valid and subject/attachments are satisfied', () => {
      const check = checkBeforeSend({
        to: [{ email: 'valid@example.com' }],
        cc: [{ email: 'director@example.com' }],
        bcc: [],
        subject: 'Haftalık Durum Raporu',
        bodyText: 'Ekli dosyayı bulabilirsiniz.',
        hasAttachments: true,
        isReplyOrForward: false,
      });

      expect(check.blocker).toBeNull();
      expect(check.confirmations).toHaveLength(0);
    });
  });

  describe('Reply and Reply All Recipient Correctness', () => {
    const SOURCE_MSG: ComposeSource = {
      from: { name: 'Gönderen Kişi', email: 'sender@sirket.com' },
      to: [
        { name: 'Benim Hesabım', email: 'ben@sirket.com' },
        { name: 'Takım Arkadaşı', email: 'teammate@sirket.com' },
      ],
      cc: [{ name: 'Yönetici', email: 'manager@sirket.com' }],
      subject: 'Proje Güncellemesi',
      date: new Date('2026-09-15T09:00:00.000Z'),
      bodyText: 'Proje tamamlandı, onay bekliyoruz.',
      bodyHtml: '<p>Proje tamamlandı, onay bekliyoruz.</p>',
    };

    it('builds reply correctly with only sender in To and reply prefix', () => {
      const result = buildComposeStart({
        mode: 'reply',
        source: SOURCE_MSG,
        selfEmail: 'ben@sirket.com',
        signature: 'Saygılarımla, Ben',
      });

      expect(result.to).toEqual([{ name: 'Gönderen Kişi', email: 'sender@sirket.com' }]);
      expect(result.cc).toEqual([]);
      expect(result.subject).toBe('Yanıt: Proje Güncellemesi');
      expect(result.bodyText).toContain('tarihinde Gönderen Kişi <sender@sirket.com> yazdı:');
      expect(result.bodyText).toContain('> Proje tamamlandı, onay bekliyoruz.');
    });

    it('builds reply-all preserving other recipients while excluding selfEmail and sender from CC', () => {
      const result = buildComposeStart({
        mode: 'replyAll',
        source: SOURCE_MSG,
        selfEmail: 'ben@sirket.com',
      });

      expect(result.to).toEqual([{ name: 'Gönderen Kişi', email: 'sender@sirket.com' }]);
      // CC should include teammate and manager, but NOT ben@sirket.com or sender@sirket.com
      const ccEmails = result.cc.map((a) => a.email);
      expect(ccEmails).toContain('teammate@sirket.com');
      expect(ccEmails).toContain('manager@sirket.com');
      expect(ccEmails).not.toContain('ben@sirket.com');
      expect(ccEmails).not.toContain('sender@sirket.com');
    });

    it('builds forward with empty recipients and forwarded header', () => {
      const result = buildComposeStart({
        mode: 'forward',
        source: SOURCE_MSG,
        selfEmail: 'ben@sirket.com',
      });

      expect(result.to).toEqual([]);
      expect(result.cc).toEqual([]);
      expect(result.subject).toBe('İlet: Proje Güncellemesi');
      expect(result.bodyText).toContain('---------- İletilen ileti ----------');
      expect(result.bodyText).toContain('Kimden: Gönderen Kişi <sender@sirket.com>');
    });
  });

  describe('Draft Autosave Race Protection Logic', () => {
    it('prevents stale save from marking subsequent edits as saved', async () => {
      // Simulate version tracking logic in useDraftAutosave
      let currentVersion = 1;
      let lastSavedVersion = 0;
      let inFlight = false;
      let pendingAfterFlight = false;
      const saveCalls: number[] = [];

      const triggerSave = async () => {
        if (inFlight) {
          pendingAfterFlight = true;
          return;
        }

        const versionToSave = currentVersion;
        if (versionToSave <= lastSavedVersion) return;

        inFlight = true;
        saveCalls.push(versionToSave);

        // Simulate async network request
        await new Promise((resolve) => setTimeout(resolve, 10));

        lastSavedVersion = versionToSave;
        inFlight = false;

        if (pendingAfterFlight) {
          pendingAfterFlight = false;
          await triggerSave();
        }
      };

      // 1. Initial save for v1
      const p1 = triggerSave();

      // 2. While v1 is in flight, user types again, raising version to v2
      currentVersion = 2;
      const p2 = triggerSave(); // will mark pendingAfterFlight

      await Promise.all([p1, p2]);

      // Both v1 and v2 should have been executed in sequence
      expect(saveCalls).toEqual([1, 2]);
      expect(lastSavedVersion).toBe(2);
    });
  });
});
