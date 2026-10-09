/**
 * Markdown rendering is sanitised.
 *
 * These are not incidental. `vue/no-v-html` is switched off for
 * MessageItem.vue and MarkdownViewerModal.vue in eslint.config.js, and the
 * sole justification is that the value they bind comes from these two
 * functions, which run DOMPurify with an explicit allowlist. Nothing tested
 * that: if SANITIZE_CONFIG were widened or the sanitize call dropped, those
 * overrides would quietly become real XSS holes with a green suite.
 *
 * The two functions have deliberately different behaviour, so they are
 * asserted separately rather than together:
 *   - renderMarkdown REMOVES disallowed HTML.
 *   - renderUserMarkdown ESCAPES it, so a user writing <placeholder> still
 *     sees it. Escaped text is inert, and the payload's characters legitimately
 *     remain present as text — so asserting the payload string is absent would
 *     be wrong for this one.
 *
 * ── A limitation of the test environment, not of the sanitiser ──
 * Each input below contains at most ONE disallowed construct. happy-dom's
 * NodeIterator does not adjust when a node is removed mid-walk (verified:
 * iterating <a><b><i> while removing visits only DIV,A, where a conformant
 * DOM visits DIV,A,B,I). DOMPurify removes nodes as it walks, so under
 * happy-dom only the first disallowed sibling is stripped and the rest come
 * through. That is the test DOM, not the product: Electron runs real
 * Chromium, where NodeIterator is spec-conformant.
 *
 * If a future test here appears to show a sanitiser bypass, check whether the
 * input has two disallowed siblings before concluding anything — and do not
 * "fix" it by loosening the sanitiser.
 */

import { describe, it, expect } from 'vitest';

import { renderMarkdown, renderUserMarkdown } from '../markdown';

describe('renderMarkdown removes disallowed HTML', () => {
  it('strips a script tag, leaving no live element', () => {
    const html = renderMarkdown('before\n\n<script>globalThis.pwned = true</script>');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('before');
  });

  it('strips inline event handlers from an allowed element', () => {
    // img is on the allowlist; onerror is not on ALLOWED_ATTR.
    const html = renderMarkdown('<img src="x" onerror="globalThis.pwned = true">');
    expect(html).toMatch(/<img/);
    expect(html).not.toMatch(/onerror/i);
  });

  it('strips a style attribute from an allowed element', () => {
    const html = renderMarkdown('<p style="position:fixed;inset:0">x</p>');
    expect(html).toMatch(/<p[^>]*>x<\/p>/);
    expect(html).not.toMatch(/style=/i);
  });

  it('removes an iframe', () => {
    expect(renderMarkdown('<iframe src="https://example.com"></iframe>')).not.toMatch(/<iframe/i);
  });

  it('removes an object', () => {
    expect(renderMarkdown('<object data="x"></object>')).not.toMatch(/<object/i);
  });

  it('removes a form', () => {
    expect(renderMarkdown('<form action="https://evil.example"></form>')).not.toMatch(/<form/i);
  });

  it('drops a javascript: URL from a markdown link', () => {
    // Written in markdown syntax so the parser passes it through and the
    // sanitiser is what has to catch it.
    const html = renderMarkdown('[click me](javascript:globalThis.pwned=true)');
    expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i);
  });
});

describe('renderMarkdown keeps legitimate markup', () => {
  it('renders emphasis, code and lists', () => {
    const html = renderMarkdown('**bold** and `code`\n\n- one\n- two');
    expect(html).toMatch(/<strong[^>]*>bold<\/strong>/);
    expect(html).toMatch(/<code[^>]*>code<\/code>/);
    expect(html).toMatch(/<li[^>]*>one<\/li>/);
  });

  it('keeps an ordinary link and its href', () => {
    const html = renderMarkdown('[docs](https://example.com/docs)');
    expect(html).toContain('https://example.com/docs');
    expect(html).toMatch(/<a[^>]*>docs<\/a>/);
  });

  it('shows a script tag inside a code fence instead of running it', () => {
    const html = renderMarkdown('```\n<script>x</script>\n```');
    expect(html).toMatch(/<pre/);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderUserMarkdown escapes HTML rather than removing it', () => {
  it('shows <placeholder> as visible text', () => {
    // Its documented reason for existing: a user typing <placeholder> should
    // see it rather than have it silently vanish.
    expect(renderUserMarkdown('use <placeholder> here')).toContain('&lt;placeholder&gt;');
  });

  it('renders a script tag inert as escaped text', () => {
    // Escaped, so no element is created — the characters remaining in the
    // output as text is the correct outcome here, not a leak.
    const html = renderUserMarkdown('<script>globalThis.pwned = true</script>');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an event handler inert as escaped text', () => {
    const html = renderUserMarkdown('<img src="x" onerror="globalThis.pwned = true">');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;img');
  });

  it('still renders ordinary markdown', () => {
    expect(renderUserMarkdown('**bold**')).toMatch(/<strong[^>]*>bold<\/strong>/);
  });
});
