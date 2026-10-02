import { describe, expect, it } from 'vitest';
import { avatarInitial, displayNameFromEmail, foldForSearch, normalizeSubject, trLower, trUpper } from './turkish.ts';

describe('trLower / trUpper (mobile turkish_test.dart)', () => {
  it('I→ı and İ→i', () => {
    expect(trLower('ISI')).toBe('ısı');
    expect(trLower('İSTANBUL')).toBe('istanbul');
    expect(trLower('IĞDIR')).toBe('ığdır');
  });

  it('i→İ and ı→I', () => {
    expect(trUpper('istanbul')).toBe('İSTANBUL');
    expect(trUpper('ısı')).toBe('ISI');
    expect(trUpper('ığdır')).toBe('IĞDIR');
  });

  it('differs from the default JavaScript casing (why the helpers exist)', () => {
    expect('ISI'.toLowerCase()).not.toBe('ısı');
    expect(trLower('ISI')).toBe('ısı');
    // Default lower-casing of İ leaves a combining dot (2 UTF-16 units); trLower does not.
    expect('İ'.toLowerCase()).toHaveLength(2);
    expect(trLower('İ')).toBe('i');
  });

  it('keeps non-special letters intact and handles mixed/empty input', () => {
    expect(trLower('ÇĞÖŞÜ')).toBe('çğöşü');
    expect(trUpper('çğöşü')).toBe('ÇĞÖŞÜ');
    expect(trLower('')).toBe('');
    expect(trUpper('abc 123')).toBe('ABC 123');
  });

  it('round trip: İ ↔ i, I ↔ ı', () => {
    expect(trUpper(trLower('İSMAİL IŞIK'))).toBe('İSMAİL IŞIK');
  });

  it('is code-point based (astral characters survive)', () => {
    expect(trLower('A😀I')).toBe('a😀ı');
  });
});

describe('foldForSearch', () => {
  it('folds Turkish accents', () => {
    expect(foldForSearch('Şahan')).toBe('sahan');
    expect(foldForSearch('Gönderilmiş Öğeler')).toBe('gonderilmis ogeler');
    expect(foldForSearch('ÇİÇEK')).toBe('cicek');
    expect(foldForSearch('ığdır')).toBe('igdir');
  });

  it('indexed and queried text meet in the same form', () => {
    expect(foldForSearch('ÖZET')).toBe(foldForSearch('özet'));
    expect(foldForSearch('Toplantı')).toBe(foldForSearch('TOPLANTI'));
    expect(foldForSearch('IŞIK')).toBe(foldForSearch('işik'));
  });

  it('folds circumflex letters', () => {
    expect(foldForSearch('kâğıt')).toBe('kagit');
    expect(foldForSearch('ÂÎÛ')).toBe('aiu');
  });

  it('leaves ASCII, digits and other scripts alone', () => {
    expect(foldForSearch('Invoice-2026 №5')).toBe('invoice-2026 №5');
    expect(foldForSearch('日本語')).toBe('日本語');
  });
});

describe('normalizeSubject (mobile turkish_test.dart)', () => {
  it('removes English prefixes', () => {
    expect(normalizeSubject('Re: Toplantı')).toBe('Toplantı');
    expect(normalizeSubject('FW: Toplantı')).toBe('Toplantı');
    expect(normalizeSubject('Fwd: Toplantı')).toBe('Toplantı');
  });

  it('removes Turkish prefixes, including dotted İ', () => {
    expect(normalizeSubject('Yanıt: Fiyat teklifi')).toBe('Fiyat teklifi');
    expect(normalizeSubject('Ynt: Fiyat teklifi')).toBe('Fiyat teklifi');
    expect(normalizeSubject('İlt: Fiyat teklifi')).toBe('Fiyat teklifi');
    expect(normalizeSubject('İLT: Fiyat teklifi')).toBe('Fiyat teklifi');
    expect(normalizeSubject('YANIT: Fiyat teklifi')).toBe('Fiyat teklifi');
  });

  it('removes repeated prefixes', () => {
    expect(normalizeSubject('Re: Re: Fwd: Rapor')).toBe('Rapor');
    expect(normalizeSubject('Yanıt: Re: Rapor')).toBe('Rapor');
  });

  it('removes counters', () => {
    expect(normalizeSubject('Re[2]: Rapor')).toBe('Rapor');
  });

  it('keeps colons inside the subject', () => {
    expect(normalizeSubject('Re: Proje: 2. faz')).toBe('Proje: 2. faz');
    expect(normalizeSubject('Proje: 2. faz')).toBe('Proje: 2. faz');
  });

  it('is null/empty safe', () => {
    expect(normalizeSubject(null)).toBe('');
    expect(normalizeSubject(undefined)).toBe('');
    expect(normalizeSubject('   ')).toBe('');
  });

  it('collapses folded-header line breaks', () => {
    expect(normalizeSubject('Re: Uzun\r\n  konu')).toBe('Uzun konu');
  });

  it('does not strip a non-prefix word before a colon', () => {
    expect(normalizeSubject('Fatura: Eylül')).toBe('Fatura: Eylül');
  });
});

describe('displayNameFromEmail', () => {
  it('turns separators into words', () => {
    expect(displayNameFromEmail('ahmet.yilmaz@firma.com')).toBe('Ahmet Yilmaz');
    expect(displayNameFromEmail('zeynep_kaya@firma.com')).toBe('Zeynep Kaya');
    expect(displayNameFromEmail('a-b+c@x.com')).toBe('A B C');
  });

  it('capitalises with the Turkish rule', () => {
    expect(displayNameFromEmail('info@pazarlik.com.tr')).toBe('İnfo');
    expect(displayNameFromEmail('ismail@firma.com')).toBe('İsmail');
  });

  it('falls back to the raw value when nothing is left', () => {
    expect(displayNameFromEmail('...@x.com')).toBe('...@x.com');
  });
});

describe('avatarInitial (mobile turkish_test.dart)', () => {
  it('uses the first letter of the name, upper-cased Turkish-style', () => {
    expect(avatarInitial('ahmet', null)).toBe('A');
    expect(avatarInitial('ismail', null)).toBe('İ');
    expect(avatarInitial('ısıl', null)).toBe('I');
  });

  it('falls back to the address', () => {
    expect(avatarInitial(null, 'zeynep@x.com')).toBe('Z');
    expect(avatarInitial('   ', 'mehmet@x.com')).toBe('M');
    expect(avatarInitial('', 'çelik@x.com')).toBe('Ç');
  });

  it('skips non-alphanumeric characters', () => {
    expect(avatarInitial('<<Kampanya>>', null)).toBe('K');
    expect(avatarInitial('123 Destek', null)).toBe('1');
    expect(avatarInitial('“” 42', null)).toBe('4');
  });

  it('returns ? for nothing usable', () => {
    expect(avatarInitial(null, null)).toBe('?');
    expect(avatarInitial('', '')).toBe('?');
    expect(avatarInitial('  ', '')).toBe('?');
    expect(avatarInitial('!!!', '')).toBe('?');
  });
});
