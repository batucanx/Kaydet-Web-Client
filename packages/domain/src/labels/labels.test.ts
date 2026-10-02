import { describe, expect, it } from 'vitest';
import { TONE_COUNT, labelKeyword, uniqueLabelKeyword } from './keywords.ts';

describe('labelKeyword (mobile label_sync_test.dart / text_hardening_test.dart)', () => {
  it('folds to ASCII with a kaydet_ prefix', () => {
    expect(labelKeyword('Kişisel')).toBe('kaydet_kisisel');
    expect(labelKeyword('İş Yeri')).toBe('kaydet_is_yeri');
    expect(labelKeyword('ÇALIŞMA')).toBe('kaydet_calisma');
  });
  it('replaces non-alphanumerics with underscores', () => {
    expect(labelKeyword('A-B c')).toBe('kaydet_a_b_c');
    expect(labelKeyword('日本')).toBe('kaydet___');
  });
  it('is only lower-case ASCII, digits and underscores (valid IMAP atom)', () => {
    expect(labelKeyword('Fatura #2026 (Nisan)')).toMatch(/^kaydet_[a-z0-9_]+$/);
  });
});

describe('uniqueLabelKeyword', () => {
  it('returns the base keyword when nothing collides', () => {
    expect(uniqueLabelKeyword('Kişisel', [])).toBe('kaydet_kisisel');
    expect(uniqueLabelKeyword('Kişisel', ['kaydet_is'])).toBe('kaydet_kisisel');
  });
  it('gives names that fold to the same ASCII distinct keywords', () => {
    expect(uniqueLabelKeyword('Kisisel', ['kaydet_kisisel'])).toBe('kaydet_kisisel_2');
    expect(uniqueLabelKeyword('Kişisel', ['kaydet_kisisel', 'kaydet_kisisel_2'])).toBe('kaydet_kisisel_3');
  });
  it('accepts any iterable', () => {
    expect(uniqueLabelKeyword('A', new Set(['kaydet_a']))).toBe('kaydet_a_2');
  });
});

describe('TONE_COUNT', () => {
  it('matches the 15-tone palette', () => expect(TONE_COUNT).toBe(15));
});
