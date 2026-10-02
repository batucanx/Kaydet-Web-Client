import { describe, expect, it } from 'vitest';
import {
  buildComposeStart,
  buildReplyHeaders,
  checkBeforeSend,
  describeSendBlocker,
  extractUserTypedBody,
  mentionsAttachment,
  prefixSubject,
  shouldWarnAboutMissingAttachment,
  sourceMarkOnSend,
} from './index.ts';
import type { ComposeSource } from './index.ts';

describe('prefixSubject', () => {
  it('adds the Turkish reply / forward prefix', () => {
    expect(prefixSubject('Toplantı', 'Yanıt')).toBe('Yanıt: Toplantı');
    expect(prefixSubject('  Toplantı  ', 'İlet')).toBe('İlet: Toplantı');
  });
  it('does not stack prefixes (mobile list: re, yanıt/yanit, fwd, ilet)', () => {
    expect(prefixSubject('Re: Toplantı', 'Yanıt')).toBe('Re: Toplantı');
    expect(prefixSubject('RE: Toplantı', 'Yanıt')).toBe('RE: Toplantı');
    expect(prefixSubject('Yanıt: Toplantı', 'Yanıt')).toBe('Yanıt: Toplantı');
    expect(prefixSubject('yanit: Toplantı', 'Yanıt')).toBe('yanit: Toplantı');
    expect(prefixSubject('Fwd: Toplantı', 'İlet')).toBe('Fwd: Toplantı');
    expect(prefixSubject('İlet: Toplantı', 'İlet')).toBe('İlet: Toplantı');
  });
  it('detects dotted-İ / upper-case Turkish prefixes (mobile missed these)', () => {
    expect(prefixSubject('İLET: Toplantı', 'İlet')).toBe('İLET: Toplantı');
    expect(prefixSubject('YANIT: Toplantı', 'Yanıt')).toBe('YANIT: Toplantı');
  });
  it('keeps `Fw:` un-recognised, as on mobile', () => {
    expect(prefixSubject('Fw: Toplantı', 'İlet')).toBe('İlet: Fw: Toplantı');
  });
  it('an empty subject still gets a prefix', () => {
    expect(prefixSubject('', 'Yanıt')).toBe('Yanıt: ');
  });
});

describe('buildComposeStart', () => {
  // 2026-09-14 is a Monday.
  const source: ComposeSource = {
    from: { email: 'ahmet@x.com', name: 'Ahmet Yılmaz' },
    to: [{ email: 'ben@y.com', name: 'Ben' }, { email: 'ali@z.com', name: '' }],
    cc: [{ email: 'BEN@y.com' }, { email: 'ayse@z.com', name: 'Ayşe' }, { email: 'ahmet@x.com' }],
    subject: 'Fiyat teklifi',
    date: new Date(2026, 8, 14, 13, 54),
    bodyText: 'Merhaba,\n\nTeklif ektedir.',
    bodyHtml: null,
  };
  const start = (mode: 'new' | 'reply' | 'replyAll' | 'forward', over: Partial<ComposeSource> = {}) =>
    buildComposeStart({ mode, source: { ...source, ...over }, selfEmail: 'ben@y.com', signature: '-- imza' });

  it('new: only the signature', () => {
    expect(buildComposeStart({ mode: 'new', source: null, selfEmail: null, signature: 'İmza' })).toEqual({
      to: [],
      cc: [],
      subject: '',
      bodyText: 'İmza',
    });
    expect(buildComposeStart({ mode: 'new', source: null, selfEmail: null })).toMatchObject({ bodyText: '' });
  });

  it('a source mode without a source degrades to a new message', () => {
    expect(buildComposeStart({ mode: 'reply', source: null, selfEmail: null })).toMatchObject({ to: [], subject: '' });
  });

  it('reply: To = sender, Yanıt: subject, quoted body with the Turkish header', () => {
    const r = start('reply');
    expect(r.to).toEqual([{ email: 'ahmet@x.com', name: 'Ahmet Yılmaz' }]);
    expect(r.cc).toEqual([]);
    expect(r.subject).toBe('Yanıt: Fiyat teklifi');
    expect(r.bodyText).toBe(
      '-- imza\n\n14 Eylül 2026 Pazartesi, 13:54 tarihinde Ahmet Yılmaz <ahmet@x.com> yazdı:\n' +
        '> Merhaba,\n>\n> Teklif ektedir.',
    );
  });

  it('reply-all: Cc = others minus me (case-insensitive) minus the sender', () => {
    const r = start('replyAll');
    expect(r.to).toEqual([{ email: 'ahmet@x.com', name: 'Ahmet Yılmaz' }]);
    expect(r.cc).toEqual([
      { email: 'ali@z.com', name: '' },
      { email: 'ayse@z.com', name: 'Ayşe' },
    ]);
    expect(r.subject).toBe('Yanıt: Fiyat teklifi');
  });

  it('reply-all keeps everyone when the account address is unknown', () => {
    const r = buildComposeStart({ mode: 'replyAll', source, selfEmail: null });
    expect(r.cc.map((a) => a.email)).toEqual(['ben@y.com', 'ali@z.com', 'BEN@y.com', 'ayse@z.com']);
  });

  it('forward: no recipients, İlet: subject, forward header block, no quote markers', () => {
    const r = start('forward');
    expect(r.to).toEqual([]);
    expect(r.cc).toEqual([]);
    expect(r.subject).toBe('İlet: Fiyat teklifi');
    expect(r.bodyText).toBe(
      '-- imza\n\n---------- İletilen ileti ----------\n' +
        'Kimden: Ahmet Yılmaz <ahmet@x.com>\n' +
        'Tarih: 14 Eylül 2026 Pazartesi, 13:54\n' +
        'Konu: Fiyat teklifi\n' +
        'Kime: Ben <ben@y.com>, ali@z.com\n\n' +
        'Merhaba,\n\nTeklif ektedir.',
    );
  });

  it('quotes the plain part of an HTML-only mail', () => {
    const r = start('reply', { bodyText: null, bodyHtml: '<p>Merhaba</p><p>Dünya</p>' });
    expect(r.bodyText.endsWith('> Merhaba\n> Dünya')).toBe(true);
    expect(start('reply', { bodyText: null, bodyHtml: null }).bodyText.endsWith('yazdı:\n>')).toBe(true);
  });

  it('a sender with no display name is shown derived from the address', () => {
    const r = start('reply', { from: { email: 'ahmet.yilmaz@x.com' } });
    expect(r.bodyText).toContain('tarihinde Ahmet Yilmaz <ahmet.yilmaz@x.com> yazdı:');
  });

  it('a sender name with a comma is quoted in the forward header so it re-parses correctly', () => {
    const r = start('forward', { from: { email: 'a@x.com', name: 'Yılmaz, Ahmet' } });
    expect(r.bodyText).toContain('Kimden: "Yılmaz, Ahmet" <a@x.com>');
  });
});

describe('buildReplyHeaders / sourceMarkOnSend', () => {
  it('reply and reply-all extend the References chain', () => {
    for (const mode of ['reply', 'replyAll'] as const) {
      expect(
        buildReplyHeaders({ mode, originalMessageId: '<c@x.com>', originalReferences: '<a@x.com> <b@x.com>' }),
      ).toEqual({ inReplyTo: '<c@x.com>', references: '<a@x.com> <b@x.com> <c@x.com>' });
    }
  });
  it('forward and new mail carry no reply headers', () => {
    expect(buildReplyHeaders({ mode: 'forward', originalMessageId: '<c@x.com>', originalReferences: null })).toBeNull();
    expect(buildReplyHeaders({ mode: 'new', originalMessageId: null, originalReferences: null })).toBeNull();
  });
  it('a source without a Message-ID still yields a (possibly empty) chain', () => {
    expect(buildReplyHeaders({ mode: 'reply', originalMessageId: null, originalReferences: null })).toEqual({
      inReplyTo: null,
      references: '',
    });
  });
  it('reply marks the source answered, forward marks it forwarded', () => {
    expect(sourceMarkOnSend('reply')).toBe('answered');
    expect(sourceMarkOnSend('replyAll')).toBe('answered');
    expect(sourceMarkOnSend('forward')).toBe('forwarded');
    expect(sourceMarkOnSend('new')).toBeNull();
  });
});

describe('mentionsAttachment (mobile attachment_reminder_test.dart)', () => {
  it('detects Turkish phrases', () => {
    for (const text of [
      'Dosya ekte bilgilerinize sunulmuştur.',
      'Faturanız ektedir.',
      'Ekteki belgeleri inceleyiniz.',
      'İstediğiniz raporu ekledim.',
      'Sunumu ekliyorum.',
      'İlişikteki formu doldurunuz.',
      'Ekli dosyayı kontrol edin.',
      'EKTE gönderdim',
      'İLİŞİKTE bulabilirsiniz',
    ]) {
      expect(mentionsAttachment(text), text).toBe(true);
    }
  });

  it('detects English phrases', () => {
    for (const text of [
      'Please find attached the report.',
      'See the attachment for details.',
      'I am attaching the invoice.',
      'Enclosed please find the documents.',
    ]) {
      expect(mentionsAttachment(text), text).toBe(true);
    }
  });

  it('does not fire on look-alike words', () => {
    for (const text of [
      'Ekim ayı toplantısı yapılacak.',
      'Ekibimiz konuyu inceliyor.',
      'Ekstra bir bilgiye gerek yoktur.',
      'Ekran görüntüsünü açamadım.',
      'Ekonomik gelişmeler değerlendirildi.',
      'Destekleriniz için çok teşekkür ederiz.',
      'Fırından sıcak ekmek aldım.',
    ]) {
      expect(mentionsAttachment(text), text).toBe(false);
    }
  });

  it('empty text never matches', () => {
    expect(mentionsAttachment('')).toBe(false);
    expect(mentionsAttachment('   ')).toBe(false);
  });
});

describe('shouldWarnAboutMissingAttachment (mobile attachment_reminder_test.dart)', () => {
  it('no warning when an attachment is present', () => {
    expect(shouldWarnAboutMissingAttachment({ subject: 'Fatura', body: 'Faturanız ektedir.', hasAttachments: true })).toBe(false);
  });

  it('warns when the subject mentions it but nothing is attached', () => {
    expect(
      shouldWarnAboutMissingAttachment({ subject: 'Ekli Rapor', body: 'Merhaba, iyi günler.', hasAttachments: false }),
    ).toBe(true);
  });

  it('a quoted "ektedir" in a reply does not mislead', () => {
    const body = 'Teşekkürler, kontrol edip döneceğim.\n\n27 Eylül 2026 tarihinde Ali <ali@example.com> yazdı:\n> Merhaba,\n> İlgili dosya ektedir.\n';
    expect(shouldWarnAboutMissingAttachment({ subject: 'Re: Rapor', body, hasAttachments: false, isReplyOrForward: true })).toBe(false);
    // Without the reply flag the whole text is inspected.
    expect(shouldWarnAboutMissingAttachment({ subject: 'Re: Rapor', body, hasAttachments: false })).toBe(true);
  });

  it('warns when the user themself promises a new attachment in a reply', () => {
    const body = 'Yeni revizeyi ekte gönderdim, lütfen inceleyin.\n\n27 Eylül 2026 tarihinde Ali <ali@example.com> yazdı:\n> Merhaba,\n> İlk taslak nasıldı?\n';
    expect(shouldWarnAboutMissingAttachment({ subject: 'Re: Rapor', body, hasAttachments: false, isReplyOrForward: true })).toBe(true);
  });
});

describe('extractUserTypedBody', () => {
  it('drops > lines and everything after a quote header', () => {
    expect(extractUserTypedBody('Yeni\n> eski\nsonra\n---------- İletilen ileti ----------\nKimden: x')).toBe('Yeni\nsonra');
    expect(extractUserTypedBody('Yeni\n\n----- Original Message -----\nx')).toBe('Yeni');
  });
});

describe('checkBeforeSend (mobile _send)', () => {
  const ok = { to: [{ email: 'a@x.com' }], cc: [], bcc: [], subject: 'Konu', bodyText: 'Merhaba', hasAttachments: false, isReplyOrForward: false };

  it('sendable mail passes without confirmations', () => {
    expect(checkBeforeSend(ok)).toEqual({ blocker: null, confirmations: [] });
  });

  it('needs a To recipient (Cc/Bcc alone are not enough)', () => {
    const r = checkBeforeSend({ ...ok, to: [], cc: [{ email: 'b@x.com' }] });
    expect(r.blocker).toEqual({ code: 'no_recipients' });
    expect(describeSendBlocker(r.blocker!)).toBe('En az bir alıcı girin.');
    expect(r.confirmations).toEqual([]);
  });

  it('every To/Cc/Bcc address must be valid; the first invalid one is reported', () => {
    const r = checkBeforeSend({ ...ok, bcc: [{ email: 'bozuk' }, { email: 'daha@bozuk' }] });
    expect(r.blocker).toEqual({ code: 'invalid_address', address: 'bozuk' });
    expect(describeSendBlocker(r.blocker!)).toBe('Geçersiz adres: bozuk');
    expect(checkBeforeSend({ ...ok, to: [{ email: 'x@y' }] }).blocker).toEqual({ code: 'invalid_address', address: 'x@y' });
  });

  it('asks about a forgotten attachment first, then about an empty subject', () => {
    const r = checkBeforeSend({ ...ok, subject: '  ', bodyText: 'Ekte gönderdim' });
    expect(r.blocker).toBeNull();
    expect(r.confirmations).toEqual(['missing_attachment', 'empty_subject']);
    expect(checkBeforeSend({ ...ok, subject: '' }).confirmations).toEqual(['empty_subject']);
    expect(checkBeforeSend({ ...ok, bodyText: 'Ekte', hasAttachments: true }).confirmations).toEqual([]);
  });
});
