/**
 * Detects the signed-in Goodreads profile so nobody has to find and paste
 * their own user id. Carried over from the reference implementation, which got
 * this right — it removes the worst step in onboarding.
 *
 * Reads one number off a link that is already on the page. It writes nothing to
 * Goodreads, sends nothing anywhere, and only ever runs on goodreads.com.
 */

import { browser, defineContentScript } from '#imports';

export default defineContentScript({
  matches: ['https://www.goodreads.com/*'],
  runAt: 'document_idle',

  main() {
    const link = document.querySelector<HTMLAnchorElement>(
      'a[href*="/user/show/"]',
    );
    const id = link?.href.match(/\/user\/show\/(\d+)/)?.[1];
    if (id) {
      void browser.storage.local.set({ detectedGoodreadsId: id });
    }
  },
});
