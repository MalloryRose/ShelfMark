import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',

  vite: () => ({
    plugins: [preact(), tailwindcss()],
  }),

  manifest: {
    name: 'Shelfmark',
    description:
      'Find which books on your reading list are on the shelf right now — print, ebook and audiobook.',

    // Only what we can justify to a store reviewer. Every catalog origin is
    // requested at runtime instead (see optional_host_permissions below), so a
    // fresh install can reach nothing until the user adds a library.
    permissions: ['storage', 'alarms', 'notifications'],

    host_permissions: [
      'https://www.goodreads.com/*',
      'https://thunder.api.overdrive.com/*',
      'https://openlibrary.org/*',
    ],

    // Print catalogs live on thousands of hosts. Asking for them up front is a
    // store-review risk and a bad privacy story; we request each library's
    // origin at the moment the user adds it.
    optional_host_permissions: ['https://*/*'],
  },
});
