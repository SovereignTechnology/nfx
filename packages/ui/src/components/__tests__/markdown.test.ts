import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../Markdown/Markdown.js';
import { isSafeHttpUrl, parseInline, parseMarkdown, toPlainText } from '../Markdown/parse.js';
import { render } from '../testing/render.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('markdown parser', () => {
  it('parses bold, italic and nesting', () => {
    expect(parseInline('a **b** c')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'strong', children: [{ type: 'text', value: 'b' }] },
      { type: 'text', value: ' c' },
    ]);
    expect(parseInline('*i* and _u_ and __b__')).toEqual([
      { type: 'em', children: [{ type: 'text', value: 'i' }] },
      { type: 'text', value: ' and ' },
      { type: 'em', children: [{ type: 'text', value: 'u' }] },
      { type: 'text', value: ' and ' },
      { type: 'strong', children: [{ type: 'text', value: 'b' }] },
    ]);
    expect(parseInline('**bold *and em***')).toEqual([
      {
        type: 'strong',
        children: [
          { type: 'text', value: 'bold ' },
          { type: 'em', children: [{ type: 'text', value: 'and em' }] },
        ],
      },
    ]);
  });

  it('leaves unbalanced or intra-word delimiters as text', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', value: '2 * 3 * 4' }]);
    expect(parseInline('snake_case_name')).toEqual([{ type: 'text', value: 'snake_case_name' }]);
    expect(parseInline('**unclosed')).toEqual([{ type: 'text', value: '**unclosed' }]);
    expect(parseInline('a * b')).toEqual([{ type: 'text', value: 'a * b' }]);
  });

  it('parses explicit and bare http(s) links', () => {
    expect(parseInline('see [docs](https://example.com/x?y=1) now')).toEqual([
      { type: 'text', value: 'see ' },
      {
        type: 'link',
        href: 'https://example.com/x?y=1',
        children: [{ type: 'text', value: 'docs' }],
      },
      { type: 'text', value: ' now' },
    ]);
    expect(parseInline('go to https://example.com/notes.')).toEqual([
      { type: 'text', value: 'go to ' },
      {
        type: 'link',
        href: 'https://example.com/notes',
        children: [{ type: 'text', value: 'https://example.com/notes' }],
      },
      { type: 'text', value: '.' },
    ]);
  });

  it('parses nostr: URIs, bare and as link targets', () => {
    const npub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    expect(parseInline(`hi nostr:${npub} there`)).toEqual([
      { type: 'text', value: 'hi ' },
      { type: 'nostr', uri: `nostr:${npub}`, entity: 'npub', bech32: npub },
      { type: 'text', value: ' there' },
    ]);
    expect(parseInline(`[Alice](nostr:${npub})`)).toEqual([
      { type: 'nostr', uri: `nostr:${npub}`, entity: 'npub', bech32: npub, label: 'Alice' },
    ]);
    expect(parseInline('nostr:bogus')).toEqual([{ type: 'text', value: 'nostr:bogus' }]);
  });

  it('never produces a link for javascript:, data:, file: or relative targets', () => {
    for (const bad of [
      '[x](javascript:alert(1))',
      '[x](JAVASCRIPT:alert(1))',
      '[x](data:text/html,<script>alert(1)</script>)',
      '[x](file:///etc/passwd)',
      '[x](/relative)',
      '[x](//protocol-relative.example)',
      '[x](vbscript:msgbox)',
    ]) {
      const tokens = parseInline(bad);
      expect(
        tokens.some((t) => t.type === 'link'),
        bad,
      ).toBe(false);
      expect(
        tokens.every((t) => t.type === 'text'),
        bad,
      ).toBe(true);
    }
    expect(isSafeHttpUrl('https://a.example')).toBe(true);
    expect(isSafeHttpUrl('http://a.example/p')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('https:')).toBe(false);
  });

  it('splits paragraphs on blank lines and keeps single newlines as breaks', () => {
    const tree = parseMarkdown('one\ntwo\n\nthree\r\n\r\nfour');
    expect(tree).toHaveLength(3);
    expect(tree[0]?.children).toEqual([
      { type: 'text', value: 'one' },
      { type: 'br' },
      { type: 'text', value: 'two' },
    ]);
    expect(toPlainText(tree)).toBe('one\ntwo\n\nthree\n\nfour');
  });

  it('caps input length and never throws on garbage', () => {
    const long = '*'.repeat(50_000);
    const tree = parseMarkdown(long, 1000);
    expect(toPlainText(tree).length).toBeLessThanOrEqual(1001);
    expect(() => parseMarkdown('[[[[((((****____\n\n\n**')).not.toThrow();
  });
});

describe('Markdown renderer — raw HTML never renders', () => {
  const nasty = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '</p><div style="color:red">x</div>',
    '<iframe src="https://evil.example"></iframe>',
    '&lt;b&gt;entity&lt;/b&gt; &amp; &#60;script&#62;',
  ];

  const ALLOWED_TAGS = new Set(['DIV', 'P', 'STRONG', 'EM', 'A', 'BR', 'SPAN']);

  for (const src of nasty) {
    it(`renders ${JSON.stringify(src)} as text`, () => {
      const r = render(createElement(Markdown, { source: src }));
      // Only the renderer's own elements exist; nothing from the source became markup.
      for (const el of r.all('*')) {
        expect(ALLOWED_TAGS.has(el.tagName), el.tagName).toBe(true);
        for (const attr of Array.from(el.attributes)) {
          expect(attr.name.startsWith('on'), `${el.tagName}[${attr.name}]`).toBe(false);
          expect(attr.name, `${el.tagName}[${attr.name}]`).not.toBe('style');
        }
      }
      // Any anchor is an autolinked http(s) URL from the text, never a source-supplied href.
      for (const a of r.all('a')) {
        expect(a.getAttribute('href')).toMatch(/^https?:\/\//);
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      }
      // The visible text is exactly the source: tags stay tags, entities are not decoded.
      expect(r.get('.nf-md').textContent).toBe(src);
      r.unmount();
    });
  }

  it('renders links with rel="noopener noreferrer" and target="_blank"', () => {
    const r = render(
      createElement(Markdown, {
        source: 'a [b](https://example.com) c https://example.org/x',
      }),
    );
    const links = r.all('a');
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('href')).toMatch(/^https:\/\//);
    }
    r.unmount();
  });

  it('renders bold/italic as <strong>/<em> and nostr refs through the slot', () => {
    const npub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const seen: string[] = [];
    const r = render(
      createElement(Markdown, {
        source: `**bold** *em* nostr:${npub}`,
        renderNostr: (ref) => {
          seen.push(ref.entity);
          return createElement('span', { className: 'chip' }, 'Alice');
        },
      }),
    );
    expect(r.get('strong').textContent).toBe('bold');
    expect(r.get('em').textContent).toBe('em');
    expect(r.get('.chip').textContent).toBe('Alice');
    expect(seen).toEqual(['npub']);
    expect(r.container.querySelectorAll('a')).toHaveLength(0);
    r.unmount();
  });

  it('falls back to a text chip for nostr refs without a slot (no href)', () => {
    const npub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const r = render(createElement(Markdown, { source: `nostr:${npub}` }));
    const chip = r.get('.nf-md__nostr');
    expect(chip.tagName).toBe('SPAN');
    expect(chip.textContent).toBe('npub1qqqq…qqqq');
    r.unmount();
  });

  it('no component source uses dangerouslySetInnerHTML or innerHTML', () => {
    const root = join(here, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== '__tests__' && name !== 'testing') walk(p);
        } else if (/\.tsx?$/.test(name) && !name.endsWith('.stories.tsx')) {
          const text = readFileSync(p, 'utf8');
          if (
            /dangerouslySetInnerHTML\s*[=:{]|\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/.test(
              text,
            )
          )
            offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
