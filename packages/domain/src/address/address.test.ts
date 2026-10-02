import { describe, expect, it } from 'vitest';
import { addressDisplay, domainOf, formatAddress, isValidEmail, parseAddressList, sameAddress } from './address.ts';
import { avatarToneIndex, fnv1a32, isPersonalEmailDomain } from './avatar.ts';

describe('isValidEmail (mobile text_and_models_test.dart)', () => {
  it('accepts valid addresses', () => {
    expect(isValidEmail('info@pazarlik.com.tr')).toBe(true);
    expect(isValidEmail('a.b+c@alt.alan.com')).toBe(true);
    expect(isValidEmail('  ali@x.com  ')).toBe(true);
  });

  it('rejects invalid addresses', () => {
    expect(isValidEmail('bozuk')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('@alan.com')).toBe(false);
    expect(isValidEmail('a@@b.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('a b@x.com')).toBe(false);
  });
});

describe('parseAddressList', () => {
  it('parses names and bare addresses', () => {
    const list = parseAddressList('Ahmet Yılmaz <ahmet@x.com>, zeynep@y.com');
    expect(list).toEqual([
      { email: 'ahmet@x.com', name: 'Ahmet Yılmaz' },
      { email: 'zeynep@y.com', name: '' },
    ]);
  });

  it('does not split on a comma inside quotes', () => {
    const list = parseAddressList('"Yılmaz, Ahmet" <a@x.com>');
    expect(list).toEqual([{ email: 'a@x.com', name: 'Yılmaz, Ahmet' }]);
  });

  it('treats semicolons as separators too', () => {
    expect(parseAddressList('a@x.com; b@y.com')).toHaveLength(2);
  });

  it('ignores empty chunks and blank input', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('  ')).toEqual([]);
    expect(parseAddressList('a@x.com,, ,b@y.com')).toHaveLength(2);
  });

  it('formatAddress → parseAddressList never confuses name and address', () => {
    const names = ['Ahmet Yılmaz', 'Yılmaz, Ahmet', 'Ahmet; Yılmaz', 'Ahmet "Ahmo" Yılmaz', 'A <B>'];
    for (const name of names) {
      const formatted = formatAddress({ email: 'a@x.com', name });
      const parsed = parseAddressList(formatted);
      expect(parsed, formatted).toHaveLength(1);
      expect(parsed[0]?.email, formatted).toBe('a@x.com');
      expect(isValidEmail(parsed[0]?.email ?? ''), formatted).toBe(true);
      // The quote character itself cannot survive inside a name.
      expect(parsed[0]?.name).toBe(name.replaceAll('"', ''));
    }
  });
});

describe('formatAddress / addressDisplay', () => {
  it('bare address without a name; plain name unquoted; special name quoted', () => {
    expect(formatAddress({ email: 'a@x.com' })).toBe('a@x.com');
    expect(formatAddress({ email: 'a@x.com', name: '  ' })).toBe('a@x.com');
    expect(formatAddress({ email: 'a@x.com', name: null })).toBe('a@x.com');
    expect(formatAddress({ email: 'a@x.com', name: 'Ali Veli' })).toBe('Ali Veli <a@x.com>');
    expect(formatAddress({ email: 'a@x.com', name: 'Yılmaz, Ali' })).toBe('"Yılmaz, Ali" <a@x.com>');
  });

  it('display falls back to a name derived from the address', () => {
    expect(addressDisplay({ email: 'ahmet.yilmaz@x.com' })).toBe('Ahmet Yilmaz');
    expect(addressDisplay({ email: 'a@x.com', name: ' Ali ' })).toBe('Ali');
  });
});

describe('sameAddress / domainOf', () => {
  it('compares addresses case-insensitively', () => {
    expect(sameAddress({ email: 'Ali@X.com' }, { email: 'ali@x.com', name: 'Farklı' })).toBe(true);
    expect(sameAddress({ email: 'a@x.com' }, { email: 'b@x.com' })).toBe(false);
  });

  it('extracts the domain', () => {
    expect(domainOf('Ali@Sirket.com')).toBe('sirket.com');
    expect(domainOf('nodomain')).toBeNull();
    expect(domainOf('trailing@')).toBeNull();
    expect(domainOf(null)).toBeNull();
  });
});

describe('avatar tone (mobile text_and_models_test.dart)', () => {
  it('matches FNV-1a known vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('same address → same tone, regardless of name or case', () => {
    expect(avatarToneIndex('ahmet@x.com', 'Ahmet', 15)).toBe(avatarToneIndex('ahmet@x.com', 'Başka Ad', 15));
    expect(avatarToneIndex('Ahmet@X.com', null, 15)).toBe(avatarToneIndex('ahmet@x.com', null, 15));
  });

  it('same first letter does not imply the same tone', () => {
    const tones = new Set(['ahmet', 'ali', 'ayse', 'arda'].map((n) => avatarToneIndex(`${n}@x.com`, null, 15)));
    expect(tones.size).toBeGreaterThan(1);
  });

  it('always inside the range; empty key and non-positive count → 0', () => {
    for (const email of ['a@x.com', 'çok.uzun.adres@alt.alan.com.tr', '']) {
      const tone = avatarToneIndex(email, null, 15);
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThanOrEqual(14);
    }
    expect(avatarToneIndex('', '', 15)).toBe(0);
    expect(avatarToneIndex('a@x.com', null, 0)).toBe(0);
  });

  it('falls back to the name when there is no address', () => {
    expect(avatarToneIndex('', 'Ayşe', 15)).toBe(fnv1a32('ayşe') % 15);
  });

  it('is reasonably balanced', () => {
    const counts = new Map<number, number>();
    for (let i = 0; i < 1500; i++) {
      const tone = avatarToneIndex(`kullanici${i}@ornek.com`, null, 15);
      counts.set(tone, (counts.get(tone) ?? 0) + 1);
    }
    expect(counts.size).toBe(15);
    expect([...counts.values()].every((c) => c < 500)).toBe(true);
  });
});

describe('isPersonalEmailDomain', () => {
  it('flags free-mail providers only', () => {
    expect(isPersonalEmailDomain('gmail.com')).toBe(true);
    expect(isPersonalEmailDomain('hotmail.com.tr')).toBe(true);
    expect(isPersonalEmailDomain('sirket.com')).toBe(false);
  });
});
