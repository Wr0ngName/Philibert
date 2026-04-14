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
  INLINE_CODE: 'px-1 py-0.5 bg-surface-100 dark:bg-surface-700 text-surface-800 dark:text-surface-200 rounded text-sm font-mono',
  LINK: 'text-primary-500 hover:underline',
} as const;

/**
 * Create a configured Marked instance with custom renderer overrides
 * for code blocks, inline code, and links to apply our CSS classes.
 */
const markedInstance = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = lang || 'text';
      const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      return `<pre class="${CLASSES.CODE_BLOCK}"><code class="language-${language}">${escaped}</code></pre>`;
    },
    codespan({ text }) {
      return `<code class="${CLASSES.INLINE_CODE}">${text}</code>`;
    },
    link({ href, text }) {
      return `<a href="${href}" class="${CLASSES.LINK}" target="_blank" rel="noopener">${text}</a>`;
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
