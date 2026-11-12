// @vitest-environment jsdom
/**
 * Markdown rendering is sanitised.
 *
 * These are not incidental. `vue/no-v-html` is switched off for
 * MessageItem.vue and MarkdownViewerModal.vue in eslint.config.mjs, and the
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
 * ── Run under jsdom, not the suite's happy-dom ──
 * DOMPurify 3.4.17 (its cross-realm fixes) no longer sanitises inside
 * happy-dom's emulated DOM: there it keeps a <script> and empties a harmless
 * <img> — while in Chromium, which Electron runs, and in jsdom it sanitises
 * as it should, several disallowed siblings included (measured 2026-11-12).
 * jsdom is DOMPurify's own test DOM, and it keeps these tests in the suite CI
 * runs. Should they ever pass under happy-dom again, do not move them back
 * without checking that it sanitises: a DOM that does not would turn this
 * file into a green suite over an XSS hole.
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
    // No src, deliberately. DOMPurify parses into a real happy-dom document,
    // and happy-dom NAVIGATES an iframe that has one — an `src` here made the
    // suite open a TLS connection to the outside world on every run, which
    // printed AsyncTaskManager/AbortError noise locally and would stall on a
    // CI container with no egress. The sanitiser drops `iframe` because the
    // tag is not on the allowlist; its URL never enters into it.
    expect(renderMarkdown('<iframe></iframe>')).not.toMatch(/<iframe/i);
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

describe('renderMarkdown removes several disallowed constructs at once', () => {
  it('strips each of them, not only the first', () => {
    const html = renderMarkdown('<p>a</p><script>1</script><object data="x"></object><img src="x" onerror="1"><iframe src="x"></iframe>');
    expect(html).toContain('<p>a</p>');
    expect(html).not.toMatch(/<script|<object|<iframe|onerror/i);
    expect(html).toMatch(/<img[^>]*src="x"/);
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
