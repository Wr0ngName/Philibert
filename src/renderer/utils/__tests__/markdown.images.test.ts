/**
 * Images in rendered markdown.
 *
 * A reference the page can load stays a `src`. A path to a file on this
 * machine cannot be loaded by the page at all — `C:` reads as a URL scheme and
 * the page's policy refuses `file:` — so it is handed over as
 * `data-local-src` for useLocalImages to read, with no `src` to draw broken.
 */

import { describe, it, expect } from 'vitest';

import { LOCAL_IMAGE_ATTR, renderMarkdown, renderUserMarkdown } from '../markdown';

function onlyImage(html: string): HTMLImageElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  const images = host.querySelectorAll('img');
  expect(images).toHaveLength(1);
  return images[0];
}

describe('markdown images', () => {
  it.each([
    'C:/Users/me/shots/grass_o6_2773_zoom.png',
    'C:\\Users\\me\\shots\\a.png',
    '/home/me/shots/a.png',
    './shots/a.png',
    'file:///C:/Users/me/a.png',
  ])('hands %s over as a local reference, with no src', (reference) => {
    const img = onlyImage(renderMarkdown(`![shot](<${reference}>)`));
    expect(img.getAttribute(LOCAL_IMAGE_ATTR)).toBe(reference);
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.alt).toBe('shot');
  });

  it('keeps a path with spaces whole', () => {
    const img = onlyImage(renderMarkdown('![a](<C:/my shots/a b.png>)'));
    expect(img.getAttribute(LOCAL_IMAGE_ATTR)).toBe('C:/my shots/a b.png');
  });

  it.each([
    'data:image/png;base64,AAAA',
    'https://example.com/a.png',
  ])('leaves %s as a src', (src) => {
    const img = onlyImage(renderMarkdown(`![a](${src})`));
    expect(img.getAttribute('src')).toBe(src);
    expect(img.hasAttribute(LOCAL_IMAGE_ATTR)).toBe(false);
  });

  it('keeps the title', () => {
    const img = onlyImage(renderMarkdown('![a](./a.png "the grass")'));
    expect(img.title).toBe('the grass');
  });

  it('draws images in what the user wrote too', () => {
    const img = onlyImage(renderUserMarkdown('![a](C:/a.png)'));
    expect(img.getAttribute(LOCAL_IMAGE_ATTR)).toBe('C:/a.png');
  });

  it('cannot be talked out of the attribute by a quote in the path', () => {
    const img = onlyImage(renderMarkdown('![a" onerror="x](<C:/a" onerror="alert(1).png>)'));
    expect(img.getAttribute('onerror')).toBeNull();
    expect(img.getAttribute(LOCAL_IMAGE_ATTR)).toBe('C:/a" onerror="alert(1).png');
    expect(img.alt).toBe('a" onerror="x');
  });
});
