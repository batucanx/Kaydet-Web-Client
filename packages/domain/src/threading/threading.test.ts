import { describe, expect, it } from 'vitest';
import {
  assignThreads,
  buildReferences,
  normalizeMessageId,
  parseReferences,
  resolveThreadId,
  subjectThreadKey,
} from './threading.ts';
import type { ThreadInput } from './threading.ts';

const msg = (
  id: string,
  subject: string | null,
  extra: Partial<Omit<ThreadInput, 'id' | 'subject'>> = {},
): ThreadInput => ({ id, subject, messageId: null, inReplyTo: null, references: null, ...extra });

describe('parseReferences (mobile threading_test.dart)', () => {
  it('extracts bracketed ids', () => {
    expect(parseReferences('<a@x.com> <b@x.com>')).toEqual(['a@x.com', 'b@x.com']);
  });
  it('reads a folded header with line breaks', () => {
    expect(parseReferences('<a@x.com>\r\n\t<b@x.com>')).toEqual(['a@x.com', 'b@x.com']);
  });
  it('accepts the bracket-less form', () => {
    expect(parseReferences('a@x.com b@x.com')).toEqual(['a@x.com', 'b@x.com']);
    expect(parseReferences('a@x.com, b@x.com')).toEqual(['a@x.com', 'b@x.com']);
  });
  it('ignores tokens that are not ids and is empty-safe', () => {
    expect(parseReferences('garbage')).toEqual([]);
    expect(parseReferences(null)).toEqual([]);
    expect(parseReferences('  ')).toEqual([]);
  });
});

describe('normalizeMessageId', () => {
  it('strips brackets; empty → null', () => {
    expect(normalizeMessageId('<abc@x.com>')).toBe('abc@x.com');
    expect(normalizeMessageId('abc@x.com')).toBe('abc@x.com');
    expect(normalizeMessageId('  <abc@x.com> ')).toBe('abc@x.com');
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId('  ')).toBeNull();
    expect(normalizeMessageId('<>')).toBe('<>');
  });
});

describe('subjectThreadKey', () => {
  it('normalises prefixes and folds Turkish letters', () => {
    expect(subjectThreadKey('Re: Sipariş Durumu')).toBe('subj:siparis durumu');
    expect(subjectThreadKey('İlt: SİPARİŞ durumu')).toBe('subj:siparis durumu');
  });
  it('no subject → no key', () => {
    expect(subjectThreadKey('')).toBeNull();
    expect(subjectThreadKey('Re:')).toBeNull();
    expect(subjectThreadKey(null)).toBeNull();
  });
});

describe('assignThreads (mobile threading_test.dart)', () => {
  it('a reply joins the ancestor conversation', () => {
    const r = assignThreads([
      msg('1', 'Fiyat teklifi', { messageId: '<kok@x.com>' }),
      msg('2', 'Re: Fiyat teklifi', { messageId: '<yanit@x.com>', inReplyTo: '<kok@x.com>', references: '<kok@x.com>' }),
    ]);
    expect(r.get('1')).toBe('kok@x.com');
    expect(r.get('2')).toBe('kok@x.com');
  });

  it('a three-level chain collapses into one conversation', () => {
    const r = assignThreads([
      msg('1', 'Proje', { messageId: '<a@x.com>' }),
      msg('2', 'Re: Proje', { messageId: '<b@x.com>', inReplyTo: '<a@x.com>', references: '<a@x.com>' }),
      msg('3', 'Re: Re: Proje', { messageId: '<c@x.com>', inReplyTo: '<b@x.com>', references: '<a@x.com> <b@x.com>' }),
    ]);
    expect(r.get('1')).toBe(r.get('2'));
    expect(r.get('2')).toBe(r.get('3'));
  });

  it('unrelated mail stays in separate conversations', () => {
    const r = assignThreads([
      msg('1', 'Fatura', { messageId: '<a@x.com>' }),
      msg('2', 'Toplantı', { messageId: '<b@x.com>' }),
    ]);
    expect(r.get('1')).not.toBe(r.get('2'));
  });

  it('mail without Message-ID merges by subject', () => {
    const r = assignThreads([msg('1', 'Günlük rapor'), msg('2', 'Re: Günlük rapor')]);
    expect(r.get('1')).toBe(r.get('2'));
  });

  it('header-less mail with an empty subject is NOT collapsed into one thread', () => {
    const r = assignThreads([msg('1', ''), msg('2', null)]);
    expect(r.get('1')).not.toBe(r.get('2'));
  });

  it('merges across Turkish reply prefixes', () => {
    const r = assignThreads([msg('1', 'Sipariş durumu'), msg('2', 'Yanıt: Sipariş durumu'), msg('3', 'İlt: Sipariş durumu')]);
    expect(r.get('1')).toBe(r.get('2'));
    expect(r.get('1')).toBe(r.get('3'));
  });

  it('mail WITH headers is not merged by subject alone', () => {
    const r = assignThreads([
      msg('1', 'Rapor', { messageId: '<a@x.com>' }),
      msg('2', 'Rapor', { messageId: '<b@x.com>' }),
    ]);
    expect(r.get('1')).not.toBe(r.get('2'));
  });

  it('an unknown ancestor makes the first reference the conversation id; later replies join it', () => {
    const r = assignThreads([
      msg('2', 'Re: X', { messageId: '<b@x.com>', references: '<root@x.com>' }),
      msg('3', 'Re: Re: X', { messageId: '<c@x.com>', inReplyTo: '<b@x.com>' }),
    ]);
    expect(r.get('2')).toBe('root@x.com');
    expect(r.get('3')).toBe('root@x.com');
  });

  it('uses an injected fallback id generator (deterministic)', () => {
    let n = 0;
    const r = assignThreads([msg('1', ''), msg('2', '')], { fallbackId: () => `solo:${n++}` });
    expect([...r.values()]).toEqual(['solo:0', 'solo:1']);
  });
});

describe('resolveThreadId', () => {
  const headers = { messageId: null, inReplyTo: null, references: null, subject: null } as const;
  it('prefers the nearest known ancestor', () => {
    const known = new Map([['a@x', 'T-a'], ['b@x', 'T-b']]);
    expect(resolveThreadId({ ...headers, references: '<a@x> <b@x>', knownThreads: known })).toBe('T-b');
    expect(resolveThreadId({ ...headers, references: '<a@x>', inReplyTo: '<b@x>', knownThreads: known })).toBe('T-b');
  });
});

describe('buildReferences (mobile text_and_models_test.dart)', () => {
  it('appends the original id to the original chain', () => {
    expect(buildReferences({ originalReferences: '<a@x.com> <b@x.com>', originalMessageId: '<c@x.com>' })).toBe(
      '<a@x.com> <b@x.com> <c@x.com>',
    );
  });
  it('starts a chain from a single id (brackets added)', () => {
    expect(buildReferences({ originalReferences: null, originalMessageId: 'c@x.com' })).toBe('<c@x.com>');
  });
  it('never adds the same id twice', () => {
    expect(buildReferences({ originalReferences: '<a@x.com>', originalMessageId: '<a@x.com>' })).toBe('<a@x.com>');
    expect(buildReferences({ originalReferences: '<a@x.com>', originalMessageId: 'a@x.com' })).toBe('<a@x.com>');
  });
  it('caps very long chains but keeps the root and the newest id', () => {
    const long = Array.from({ length: 40 }, (_, i) => `<m${i}@x.com>`).join(' ');
    const result = buildReferences({ originalReferences: long, originalMessageId: '<son@x.com>' });
    expect(result.match(/<[^>]+>/g)).toHaveLength(20);
    expect(result.startsWith('<m0@x.com>')).toBe(true);
    expect(result.endsWith('<son@x.com>')).toBe(true);
  });
  it('nothing in → empty string', () => {
    expect(buildReferences({ originalReferences: null, originalMessageId: null })).toBe('');
  });
});
