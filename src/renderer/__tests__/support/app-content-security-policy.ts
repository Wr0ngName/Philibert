/**
 * Enforce the app's own Content-Security-Policy on a browser test page.
 *
 * The browser suite mounts components into a bare page and never loads
 * `index.html`, so without this a policy that refuses a kind of URL the app
 * relies on passes every component test and draws a broken image for the
 * user. Lifted out of `index.html` itself, so it cannot drift from what ships.
 */

import indexHtml from '../../../../index.html?raw';

export function enforceAppContentSecurityPolicy(): void {
  const policy = new DOMParser()
    .parseFromString(indexHtml, 'text/html')
    .querySelector('meta[http-equiv="Content-Security-Policy"]')
    ?.getAttribute('content');
  if (!policy) throw new Error('index.html carries no Content-Security-Policy');

  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = policy;
  document.head.appendChild(meta);
}
