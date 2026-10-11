import { describe, it, expect } from 'vitest';
import { sanitizeHtml, sanitizeDescriptionHtml } from './html-sanitize.js';
import { activityInputSchema } from './schemas.js';

describe('sanitizeHtml', () => {
  it('strips <script> tags and their contents entirely', () => {
    const out = sanitizeHtml('<p>Hi</p><script>alert(document.cookie)</script>');
    expect(out).toContain('<p>Hi</p>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('alert(');
  });

  it('removes on* event-handler attributes from allowed tags', () => {
    const out = sanitizeHtml('<p onclick="steal()">x</p>');
    expect(out).toBe('<p>x</p>');
    expect(out.toLowerCase()).not.toContain('onclick');
  });

  it('drops unknown tags but keeps their text (e.g. <img onerror>)', () => {
    const out = sanitizeHtml('<img src=x onerror="alert(1)">caption');
    expect(out.toLowerCase()).not.toContain('<img');
    expect(out.toLowerCase()).not.toContain('onerror');
    expect(out).toContain('caption');
  });

  it('keeps a safe http href on <a> and adds rel hardening', () => {
    const out = sanitizeHtml('<a href="https://example.com/x">link</a>');
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('rel="nofollow noopener noreferrer"');
  });

  it('drops a javascript: href but keeps the anchor shell', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).toBe('<a>x</a>');
    expect(out.toLowerCase()).not.toContain('javascript');
  });

  it('defeats entity-encoded javascript: schemes', () => {
    const out = sanitizeHtml('<a href="java&#115;cript:alert(1)">x</a>');
    expect(out).toBe('<a>x</a>');
  });

  it('defeats whitespace/control-char obfuscated schemes', () => {
    const out = sanitizeHtml('<a href="  java\tscript:alert(1)">x</a>');
    expect(out).toBe('<a>x</a>');
  });

  it('drops data: and vbscript: hrefs', () => {
    expect(sanitizeHtml('<a href="data:text/html;base64,PHN2Zz4=">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')).toBe('<a>x</a>');
  });

  it('allows relative and fragment hrefs', () => {
    expect(sanitizeHtml('<a href="/foo?a=b#c">x</a>')).toContain('href="/foo?a=b#c"');
    expect(sanitizeHtml('<a href="#section">x</a>')).toContain('href="#section"');
  });

  it('escapes stray angle brackets in text', () => {
    const out = sanitizeHtml('5 < 10 and 10 > 5');
    expect(out).toContain('5 &lt; 10');
    expect(out).toContain('10 &gt; 5');
  });

  it('drops HTML comments (which can hide conditional-comment script)', () => {
    const out = sanitizeHtml('a<!-- <script>evil()</script> -->b');
    expect(out).toBe('ab');
  });

  it('preserves ordinary formatting markup', () => {
    const out = sanitizeHtml('<p><strong>Bold</strong> and <em>italic</em></p><ul><li>one</li></ul>');
    expect(out).toBe('<p><strong>Bold</strong> and <em>italic</em></p><ul><li>one</li></ul>');
  });

  it('strips style tags and svg/iframe payloads', () => {
    expect(sanitizeHtml('<style>*{x}</style>ok').toLowerCase()).not.toContain('<style');
    expect(sanitizeHtml('<iframe src="javascript:1"></iframe>ok').toLowerCase()).not.toContain(
      '<iframe',
    );
    const svg = sanitizeHtml('<svg><script>alert(1)</script></svg>caption');
    expect(svg.toLowerCase()).not.toContain('<svg');
    expect(svg.toLowerCase()).not.toContain('<script');
    expect(svg).toContain('caption');
  });

  it('handles nullish via sanitizeDescriptionHtml', () => {
    expect(sanitizeDescriptionHtml(null)).toBeUndefined();
    expect(sanitizeDescriptionHtml(undefined)).toBeUndefined();
    expect(sanitizeDescriptionHtml('<b>x</b>')).toBe('<b>x</b>');
  });
});

describe('activityInputSchema sanitizes description_html on parse (write boundary)', () => {
  const base = {
    name_internal: 'Internal',
    name_external: 'External',
  };

  it('strips a stored-XSS payload at validation time', () => {
    const parsed = activityInputSchema.parse({
      ...base,
      description_html: '<p>Great trip</p><img src=x onerror="fetch(`/evil`)">',
    });
    expect(parsed.description_html).toBe('<p>Great trip</p>');
    expect(parsed.description_html?.toLowerCase()).not.toContain('onerror');
  });

  it('leaves clean rich text intact', () => {
    const parsed = activityInputSchema.parse({
      ...base,
      description_html: '<p>Bring <strong>sunscreen</strong>.</p>',
    });
    expect(parsed.description_html).toBe('<p>Bring <strong>sunscreen</strong>.</p>');
  });
});
