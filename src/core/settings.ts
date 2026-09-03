/**
 * Settings — and only settings — live in chrome.storage.local.
 *
 * Book data belongs in IndexedDB (see db.ts). The split matters: this store is
 * small, read whole, and safe to lose; that one is large and queried.
 */

import { browser } from '#imports';
import type { LibraryConfig } from './types';

export interface Settings {
  goodreadsId?: string;
  /** Shelves the user chose to scan. Default is the one everyone means. */
  selectedShelves: string[];
  libraries: LibraryConfig[];
  /** Cached entitlement, refreshed on popup open. Never the source of truth. */
  isPro: boolean;
  lastRunAt?: number;
  autoScanEnabled: boolean;
}

const DEFAULTS: Settings = {
  selectedShelves: ['to-read'],
  libraries: [],
  isPro: false,
  autoScanEnabled: false,
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEY);
  return { ...DEFAULTS, ...((stored[KEY] as Partial<Settings> | undefined) ?? {}) };
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export async function enabledLibraries(): Promise<LibraryConfig[]> {
  return (await getSettings()).libraries.filter((l) => l.enabled);
}

/**
 * Ask for a catalog's origin only when the user adds it.
 *
 * This is why `optional_host_permissions` is in the manifest rather than a
 * blanket grant: a fresh install can reach no catalog at all, which is both
 * easier to defend in store review and true in a way users can verify.
 */
export async function requestLibraryPermission(baseUrl: string): Promise<boolean> {
  const origin = `${new URL(baseUrl).origin}/*`;
  return browser.permissions.request({ origins: [origin] });
}

export async function hasLibraryPermission(baseUrl: string): Promise<boolean> {
  const origin = `${new URL(baseUrl).origin}/*`;
  return browser.permissions.contains({ origins: [origin] });
}
