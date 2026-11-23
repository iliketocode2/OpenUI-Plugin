import { describe, expect, it } from 'vitest';
import { isWebLink } from '../../src/ui/chatViewProvider';
import { renderMarkdown } from '../../webview/src/markdown';

/** The tags Markdown itself produces, and syntax highlighting adds. Anything else came from the model's text. */
const TAGS = new Set(['p', 'a', 'code', 'pre', 'span', 'em', 'strong', 'ul', 'ol', 'li', 'blockquote', 'hr', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 's']);

/** Model output is untrusted, and the webview inserts the result as HTML. Every tag and attribute must be one Markdown
 * makes, and every link a web, mail or relative one, so nothing the model writes can run script. */
function expectSafe(html: string): void {
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [tag, name, attrs] = m;
    expect(TAGS.has(name!.toLowerCase()), `unexpected tag ${tag}`).toBe(true);
    for (const a of attrs!.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
      const attr = a[1]!.toLowerCase();
      expect(['class', 'href', 'start', 'style'].includes(attr), `unexpected attribute in ${tag}`).toBe(true);
      if (attr === 'style') expect(a[2], tag).toMatch(/^text-align:(left|right|center)$/);
      if (attr === 'href') expect(a[2], tag).toMatch(/^(https?:|mailto:|#|[^:]*$)/i);
    }
  }
}

const HOSTILE = [
  '<script>window.pwned = 1</script>',
  '<img src=x onerror="window.pwned = 1">',
  '<iframe src="https://evil.example"></iframe>',
  '<a href="javascript:alert(1)">raw link</a>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](java&#x73;cript:alert(1))',
  '[click](  javascript:alert(1))',
  '[click](vbscript:msgbox(1))',
  '[click](data:text/html,<script>alert(1)</script>)',
  '[click](file:///etc/passwd)',
  '[click](command:workbench.action.terminal.new)',
  '![x](https://tracker.example/pixel.png)',
  '![x](javascript:alert(1))',
  '<javascript:alert(1)>',
  '[x]: javascript:alert(1)\n\n[ref link][x]',
  '```"><img src=x onerror=alert(1)>\ncode\n```',
  '```js\n</code></pre><script>alert(1)</script>\n```',
  '`<script>alert(1)</script>`',
  '| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |',
  '<details open ontoggle=alert(1)>',
  '<svg onload=alert(1)>',
];

describe('renderMarkdown with hostile model output', () => {
  it.each(HOSTILE)('renders %j without markup that can run script', (text) => {
    const html = renderMarkdown(text);
    expectSafe(html);
    expect(html).not.toMatch(/<(script|img|iframe|svg|details)\b/i);
    expect(html).not.toMatch(/href="\s*(javascript|vbscript|data|file|command):/i);
  });

  it('keeps raw HTML visible as text', () => {
    expect(renderMarkdown('<b>bold</b>')).toBe('<p>&lt;b&gt;bold&lt;/b&gt;</p>\n');
  });

  it('still renders ordinary Markdown, links and highlighted code', () => {
    const html = renderMarkdown('# Title\n\n**bold** and [docs](https://example.com/a) and https://example.org\n\n```ts\nconst x = 1;\n```');
    expectSafe(html);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<a href="https://example.com/a">docs</a>');
    expect(html).toContain('<a href="https://example.org">https://example.org</a>');
    expect(html).toContain('<span class="code-lang">ts</span>');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  it('closes a code fence the model is still streaming', () => {
    const html = renderMarkdown('Here:\n```py\nprint("<b>")');
    expectSafe(html);
    expect(html).toContain('<pre class="code">');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('isWebLink', () => {
  it('lets only http and https links open', () => {
    for (const href of ['https://example.com/', 'http://localhost:3000/x?y=1', 'HTTPS://EXAMPLE.COM']) expect(isWebLink(href), href).toBe(true);
    for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'command:workbench.action.terminal.new', 'vscode://settings', 'mailto:a@b.c', 'data:text/html,x', 'src/a.ts', '#top', '', 'https//missing-colon'])
      expect(isWebLink(href), href).toBe(false);
  });
});
