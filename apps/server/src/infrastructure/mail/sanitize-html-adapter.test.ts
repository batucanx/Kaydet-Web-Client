import { describe, expect, it } from 'vitest';
import { SanitizeHtmlAdapter } from './sanitize-html-adapter.ts';

describe('SanitizeHtmlAdapter', () => {
  const sanitizer = new SanitizeHtmlAdapter();

  it('strips <script> tags and executable code', () => {
    const raw = '<p>Hello</p><script>alert("pwned")</script><p>World</p>';
    const clean = sanitizer.sanitize(raw);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('alert');
    expect(clean).toContain('<p>Hello</p>');
    expect(clean).toContain('<p>World</p>');
  });

  it('strips all on* event handler attributes', () => {
    const raw = '<img src="x" onerror="alert(1)" onload="evil()" onclick="bad()">';
    const clean = sanitizer.sanitize(raw);
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('onload');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('alert');
  });

  it('removes javascript: and vbscript: URIs in href and src', () => {
    const raw = '<a href="javascript:alert(1)">Click me</a><a href="vbscript:msgbox">Click 2</a>';
    const clean = sanitizer.sanitize(raw);
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('vbscript:');
    expect(clean).toContain('Click me');
  });

  it('allows safe http, https, mailto and cid links', () => {
    const raw = `
      <p>
        <a href="https://example.com/test">Website</a>
        <a href="mailto:test@example.com">Email</a>
        <img src="cid:part123@example.com" alt="Inline Image">
      </p>
    `;
    const clean = sanitizer.sanitize(raw);
    expect(clean).toContain('href="https://example.com/test"');
    expect(clean).toContain('target="_blank"');
    expect(clean).toContain('rel="noopener noreferrer"');
    expect(clean).toContain('href="mailto:test@example.com"');
    expect(clean).toContain('src="cid:part123@example.com"');
  });

  it('removes dangerous tags: iframe, embed, object, form, input, button', () => {
    const raw = `
      <iframe src="https://evil.com"></iframe>
      <embed src="evil.swf">
      <object data="evil"></object>
      <form action="https://evil.com"><input type="password"><button>Submit</button></form>
    `;
    const clean = sanitizer.sanitize(raw);
    expect(clean).not.toContain('<iframe');
    expect(clean).not.toContain('<embed');
    expect(clean).not.toContain('<object');
    expect(clean).not.toContain('<form');
    expect(clean).not.toContain('<input');
    expect(clean).not.toContain('<button');
  });

  it('preserves email layout structures (tables, divs, formatting)', () => {
    const raw = `
      <div style="font-family: Arial;">
        <table border="1">
          <tr>
            <td><b>Bold text</b></td>
            <td><i>Italic text</i></td>
          </tr>
        </table>
      </div>
    `;
    const clean = sanitizer.sanitize(raw);
    expect(clean).toMatch(/font-family:\s*Arial/);
    expect(clean).toContain('<table');
    expect(clean).toContain('<b>Bold text</b>');
    expect(clean).toContain('<i>Italic text</i>');
  });

  it('handles empty or whitespace strings safely', () => {
    expect(sanitizer.sanitize('')).toBe('');
    expect(sanitizer.sanitize('   ')).toBe('');
  });
});
