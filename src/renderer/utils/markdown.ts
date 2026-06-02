/**
 * Markdown rendering utility for chat messages
 *
 * Uses `marked` for CommonMark-compliant parsing and DOMPurify for XSS sanitization.
 */

import DOMPurify, { type Config } from 'dompurify';
import { Marked } from 'marked';

/**
 * DOMPurify configuration — allow all tags that marked can produce.
 */
const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    // Block elements
    'p', 'pre', 'code', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    // Inline elements
    'span', 'strong', 'em', 'del', 'a', 'img',
  ],
  ALLOWED_ATTR: ['class', 'href', 'target', 'rel', 'src', 'alt', 'title'],
  RETURN_TRUSTED_TYPE: false,
};

/**
 * CSS classes for rendered markdown elements
 */
const CLASSES = {
  CODE_BLOCK: 'code-block',
  INLINE_CODE: 'px-1 py-0.5 bg-surface-100 dark:bg-surface-700 text-surface-800 dark:text-surface-200 rounded-sm text-sm font-mono',
  LINK: 'text-primary-500 hover:underline',
} as const;

const sharedRenderer = {
  code({ text, lang }: { text: string; lang?: string }) {
    const language = lang || 'text';
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return `<pre class="${CLASSES.CODE_BLOCK}"><code class="language-${language}">${escaped}</code></pre>`;
  },
  codespan({ text }: { text: string }) {
    return `<code class="${CLASSES.INLINE_CODE}">${text}</code>`;
  },
  link({ href, text }: { href: string; text: string }) {
    return `<a href="${href}" class="${CLASSES.LINK}" target="_blank" rel="noopener">${text}</a>`;
  },
};

const markedInstance = new Marked({
  gfm: true,
  breaks: true,
  renderer: sharedRenderer,
});

// User messages: escape HTML-like content instead of passing it through.
// Marked tokenizes <word> as inline HTML; the default renderer passes it to
// DOMPurify which strips unknown tags. This instance converts those tokens
// to visible escaped text so angle-bracket content is preserved.
const userMarkedInstance = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    ...sharedRenderer,
    html({ text }: { text: string }) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    },
  },
});

/**
 * Render markdown content to sanitized HTML.
 *
 * @param content - The markdown content to render
 * @returns Sanitized HTML string
 */
export function renderMarkdown(content: string): string {
  const html = markedInstance.parse(content) as string;
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/**
 * Render user-authored content — angle-bracket text like <something>
 * is preserved as visible text instead of being stripped as HTML.
 */
export function renderUserMarkdown(content: string): string {
  const html = userMarkedInstance.parse(content) as string;
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}
