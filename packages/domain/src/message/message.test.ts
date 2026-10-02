import { describe, expect, it } from 'vitest';
import {
  EMPTY_MESSAGE_FILTER,
  applyMessageFilter,
  buildPreview,
  decodeEntities,
  htmlToPlain,
  isFilterActive,
  quoteText,
  resolveColorSchemeQueries,
  stripMetaRefresh,
  stripViewportMeta,
  supportsDarkScheme,
} from './index.ts';
import type { FilterableMessage, MessageFilter } from './index.ts';

describe('htmlToPlain (mobile text_and_models_test.dart)', () => {
  it('drops tags but keeps the line structure', () => {
    const text = htmlToPlain('<p>Merhaba</p><p>İkinci paragraf</p>');
    expect(text).toContain('Merhaba');
    expect(text).toContain('İkinci paragraf');
    expect(text).not.toContain('<p>');
    expect(text.split('\n').length).toBeGreaterThan(1);
  });

  it('drops script and style content', () => {
    expect(htmlToPlain('<style>.a{color:red}</style><script>var x=1;</script><p>Metin</p>')).toBe('Metin');
  });

  it('decodes entities', () => {
    expect(htmlToPlain('<p>Fiyat &amp; teklif&nbsp;hazır</p>')).toBe('Fiyat & teklif hazır');
    expect(decodeEntities('&#214;zet')).toBe('Özet');
    expect(decodeEntities('&#x130;stanbul')).toBe('İstanbul');
  });

  it('turns br into line breaks', () => {
    expect(htmlToPlain('Bir<br>İki<br/>Üç')).toBe('Bir\nİki\nÜç');
    expect(htmlToPlain('Bir<BR />İki')).toBe('Bir\nİki');
  });

  it('collapses blank runs and trims lines', () => {
    expect(htmlToPlain('<div>a</div><div></div><div></div><div></div><div>b</div>')).toBe('a\n\nb');
    expect(htmlToPlain('<p>  a \t b  </p>')).toBe('a b');
  });
});

describe('HTML hardening (mobile text_hardening_test.dart)', () => {
  it('never decodes twice: &amp;lt; stays "&lt;"', () => {
    expect(decodeEntities('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
    expect(decodeEntities('&#38;amp;')).toBe('&amp;');
  });

  it('decodes named and numeric entities in a single pass', () => {
    expect(decodeEntities('&lt;b&gt; &amp; &quot;x&quot;')).toBe('<b> & "x"');
    expect(decodeEntities('&#214;zet &#x130;stanbul')).toBe('Özet İstanbul');
  });

  it('keeps unknown/broken entities and invalid code points as written', () => {
    expect(decodeEntities('&bilinmeyen; &#zz; &amp')).toBe('&bilinmeyen; &#zz; &amp');
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;');
    expect(decodeEntities('&#0;')).toBe('&#0;');
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
  });

  it('decodes astral numeric entities', () => {
    expect(decodeEntities('&#x1F600;')).toBe('😀');
  });

  it('removes script/style/head/title blocks, keeps the body', () => {
    const html =
      '<html><head><title>Başlık</title><style>p{color:red}</style></head>' +
      '<body><script>alert(1)</script><p>Merhaba dünya</p></body></html>';
    expect(htmlToPlain(html)).toBe('Merhaba dünya');
  });

  it('does not treat <header> as <head>', () => {
    expect(htmlToPlain('<header>Üst bilgi</header><p>Metin</p>')).toContain('Üst bilgi');
  });

  it('drops comments; an unclosed comment stays', () => {
    expect(htmlToPlain('Bir<!-- gizli -->İki')).toBe('Bir İki');
    expect(htmlToPlain('Başı <!-- kapanmayan yorum')).toContain('kapanmayan yorum');
  });

  it('drops tags; an unclosed "<" and an empty "<>" stay as text', () => {
    expect(htmlToPlain('<b>kalın</b> <i>eğik</i>')).toBe('kalın eğik');
    expect(htmlToPlain('5 < 6')).toBe('5 < 6');
    expect(htmlToPlain('x <> y')).toBe('x <> y');
  });

  it('is linear-time on hostile input (many unclosed openers)', () => {
    const cases: Array<[string, string]> = [
      [`${'<style>a'.padEnd(20, ' ').repeat(8000)}<p>son</p>`, 'son'],
      [`${'<script '.padEnd(12, 'x').repeat(20000)}<p>son</p>`, 'son'],
      [`${'<!-- x '.padEnd(12, ' ').repeat(8000)}metin`, 'metin'],
    ];
    for (const [html, needle] of cases) {
      const started = Date.now();
      expect(htmlToPlain(html)).toContain(needle);
      expect(Date.now() - started).toBeLessThan(3000);
    }
    const lts = '<'.repeat(300_000);
    const started = Date.now();
    expect(htmlToPlain(lts)).toBe(lts);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('buildPreview (mobile text_and_models_test.dart)', () => {
  it('skips a quoted reply', () => {
    const body =
      'Teşekkürler, uygundur.\n\n' +
      '14 Eylül 2026 tarihinde Ahmet Yılmaz <a@x.com> yazdı:\n' +
      '> Merhaba, teklifi gönderiyorum.';
    expect(buildPreview(body)).toBe('Teşekkürler, uygundur.');
  });

  it('stops at the signature delimiter', () => {
    expect(buildPreview('Kısa mesaj.\n--\nAhmet Yılmaz\nGenel Müdür')).toBe('Kısa mesaj.');
    expect(buildPreview('Kısa mesaj.\n-- \nAhmet')).toBe('Kısa mesaj.');
  });

  it('stops at English/German quote headers and forward headers', () => {
    expect(buildPreview('Thanks!\nOn Mon, Ali wrote:\n> hi')).toBe('Thanks!');
    expect(buildPreview('Danke\nAli schrieb:\n> hi')).toBe('Danke');
    expect(buildPreview('Bakınız\n---------- İletilen ileti ----------\nKimden: x')).toBe('Bakınız');
    expect(buildPreview('See\n----- Original Message -----\nFrom: x')).toBe('See');
  });

  it('truncates long text with an ellipsis', () => {
    const preview = buildPreview('a'.repeat(300), 50);
    expect(preview.length).toBeLessThanOrEqual(51);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('joins lines and stops once maxLength is reached', () => {
    const preview = buildPreview('bir\niki\nüç', 140);
    expect(preview).toBe('bir iki üç');
    expect(buildPreview(`${'x'.repeat(100)}\n${'y'.repeat(100)}\nz`, 140)).toBe(`${'x'.repeat(100)} ${'y'.repeat(39)}…`);
  });

  it('empty body → empty preview', () => {
    expect(buildPreview(null)).toBe('');
    expect(buildPreview('   \n\n  ')).toBe('');
  });

  it('a body that is only a quote still shows something', () => {
    expect(buildPreview('> Sadece alıntı var.')).not.toBe('');
  });
});

describe('quoteText', () => {
  it('prefixes lines; empty lines get a bare ">"', () => {
    expect(quoteText('a\n\nb')).toBe('> a\n>\n> b');
  });
});

describe('dark scheme handling (mobile text_and_models_test.dart)', () => {
  it('detects a mail with its own dark theme', () => {
    expect(supportsDarkScheme('@media (prefers-color-scheme: dark) { a { color: #fff } }')).toBe(true);
    expect(supportsDarkScheme('@media (PREFERS-COLOR-SCHEME:DARK){}')).toBe(true);
    expect(supportsDarkScheme('<p style="color:#000">Merhaba</p>')).toBe(false);
  });

  it('dark app: dark query true, light query false', () => {
    const css =
      '@media (prefers-color-scheme: dark) { .a { color: #fff } } ' +
      '@media (prefers-color-scheme: light) { .a { color: #000 } }';
    const resolved = resolveColorSchemeQueries(css, { dark: true });
    expect(resolved).toContain('@media (min-width: 0px) { .a { color: #fff');
    expect(resolved).toContain('@media (max-width: 0px) { .a { color: #000');
  });

  it('light app: the opposite; the rest of the query is preserved', () => {
    expect(
      resolveColorSchemeQueries('@media screen and (prefers-color-scheme:dark) and (min-width: 480px) { }', {
        dark: false,
      }),
    ).toBe('@media screen and (max-width: 0px) and (min-width: 480px) { }');
  });

  it('leaves responsive breakpoints alone', () => {
    const html =
      '<style>@media only screen and (max-width: 600px) { .c { width: 100% } }' +
      '.w { max-width: 600px; margin: 0 auto }</style>';
    expect(stripViewportMeta(html)).toBe(html);
    expect(resolveColorSchemeQueries(html, { dark: true })).toBe(html);
    expect(resolveColorSchemeQueries(html, { dark: false })).toBe(html);
  });
});

describe('meta stripping (mobile text_hardening_test.dart)', () => {
  it('removes every refresh meta variant', () => {
    const html =
      '<head><meta http-equiv="refresh" content="0;url=https://kotu.example">' +
      '<META HTTP-EQUIV=refresh CONTENT="5">' +
      "<meta http-equiv='Refresh' content='1'></head><p>Merhaba</p>";
    const cleaned = stripMetaRefresh(html);
    expect(cleaned.toLowerCase()).not.toContain('refresh');
    expect(cleaned).toContain('<p>Merhaba</p>');
  });

  it('leaves other meta tags alone', () => {
    const html =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">';
    expect(stripMetaRefresh(html)).toBe(html);
  });

  it("removes the mail's own viewport meta only", () => {
    const cleaned = stripViewportMeta('<meta charset="utf-8"><meta name="viewport" content="width=600"><p>x</p>');
    expect(cleaned).toBe('<meta charset="utf-8"><p>x</p>');
  });
});

describe('message filter and sort (mobile MessageFilter.apply)', () => {
  const m = (
    id: string,
    over: Partial<FilterableMessage> & { name?: string; email?: string } = {},
  ): FilterableMessage & { id: string } => ({
    id,
    seen: true,
    pinned: false,
    hasAttachments: false,
    labels: [],
    subject: id,
    date: '2026-09-01T10:00:00.000Z',
    from: { name: over.name ?? '', email: over.email ?? `${id}@x.com` },
    ...over,
  });
  const ids = (list: Array<{ id: string }>) => list.map((x) => x.id);
  const f = (over: Partial<MessageFilter>): MessageFilter => ({ ...EMPTY_MESSAGE_FILTER, ...over });

  it('default filter is inactive; any toggle or non-default sort activates it', () => {
    expect(isFilterActive(EMPTY_MESSAGE_FILTER)).toBe(false);
    expect(isFilterActive(f({ unread: true }))).toBe(true);
    expect(isFilterActive(f({ pinned: true }))).toBe(true);
    expect(isFilterActive(f({ attachments: true }))).toBe(true);
    expect(isFilterActive(f({ label: 'İş' }))).toBe(true);
    expect(isFilterActive(f({ sort: 'dateAsc' }))).toBe(true);
    expect(isFilterActive(f({ sort: 'dateDesc' }))).toBe(false);
  });

  const data = [
    m('a', { seen: false, date: '2026-09-03T10:00:00.000Z', labels: ['İş'] }),
    m('b', { pinned: true, date: '2026-09-02T10:00:00.000Z', hasAttachments: true }),
    m('c', { seen: false, pinned: true, date: '2026-09-01T10:00:00.000Z', labels: ['İş', 'Kişisel'] }),
  ];

  it('toggles are independent and combine with AND', () => {
    expect(ids(applyMessageFilter(data, f({ unread: true })))).toEqual(['a', 'c']);
    expect(ids(applyMessageFilter(data, f({ pinned: true })))).toEqual(['b', 'c']);
    expect(ids(applyMessageFilter(data, f({ attachments: true })))).toEqual(['b']);
    expect(ids(applyMessageFilter(data, f({ label: 'İş' })))).toEqual(['a', 'c']);
    expect(ids(applyMessageFilter(data, f({ unread: true, pinned: true })))).toEqual(['c']);
    expect(ids(applyMessageFilter(data, f({ label: 'Yok' })))).toEqual([]);
  });

  it('dateDesc sorts newest first regardless of input order; dateAsc is the exact reverse', () => {
    expect(ids(applyMessageFilter([data[2]!, data[0]!, data[1]!], EMPTY_MESSAGE_FILTER))).toEqual(['a', 'b', 'c']);
    expect(ids(applyMessageFilter(data, f({ sort: 'dateAsc' })))).toEqual(['c', 'b', 'a']);
  });

  it('does not mutate its input', () => {
    const copy = [...data];
    applyMessageFilter(data, f({ sort: 'subjectAZ' }));
    expect(data).toEqual(copy);
  });

  it('sorts by sender with Turkish lower-casing, falling back to the address', () => {
    const list = [
      m('1', { name: 'Zeynep' }),
      m('2', { name: 'ali' }),
      m('3', { name: '', email: 'burak@x.com' }),
      m('4', { name: 'İsmail' }),
      m('5', { name: 'Ilgaz' }),
    ];
    // trLower: 'İsmail' → 'ismail' (sorts among i…), 'Ilgaz' → 'ılgaz' ('ı' U+0131 sorts after 'z').
    expect(ids(applyMessageFilter(list, f({ sort: 'senderAZ' })))).toEqual(['2', '3', '4', '1', '5']);
  });

  it('compares by UTF-16 code unit, not locale collation (mobile parity)', () => {
    const list = [m('ç', { subject: 'çilek' }), m('z', { subject: 'zeytin' }), m('a', { subject: 'armut' })];
    // Under Turkish collation 'ç' would sort before 'z'; by code unit it sorts after.
    expect(ids(applyMessageFilter(list, f({ sort: 'subjectAZ' })))).toEqual(['a', 'z', 'ç']);
  });
});
