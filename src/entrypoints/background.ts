/**
 * The background service worker.
 *
 * Deliberately thin. It registers listeners, routes requests, and holds no
 * scan state in module scope — because module scope does not survive worker
 * termination, and a scan that outlives the worker is the normal case, not the
 * exception. Everything durable lives in IndexedDB.
 */

import { browser, defineBackground } from '#imports';
import { serve } from '../core/messages';
import {
  SCAN_ALARM,
  cancelScan,
  resumeInterruptedScan,
  runScanTick,
  scanStatus,
  startScan,
} from '../core/scan-queue';
import { getSettings, patchSettings } from '../core/settings';
import { listShelves } from '../shelf/goodreads-rss';
import { syncShelves } from '../shelf/sync';

/** Daily auto-scan. One alarm a day, not one a minute. */
const AUTO_SCAN_ALARM = 'shelfmark:auto-scan';
const AUTO_SCAN_PERIOD_MIN = 24 * 60;

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === 'install') {
      await browser.tabs.create({ url: browser.runtime.getURL('/popup.html') });
    }
    await ensureAutoScanAlarm();
  });

  // A cold start means the worker was terminated — possibly mid-scan. Pick up
  // where we left off rather than waiting for the user to notice.
  void resumeInterruptedScan();
  void ensureAutoScanAlarm();

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SCAN_ALARM) {
      void runScanTick();
    } else if (alarm.name === AUTO_SCAN_ALARM) {
      void maybeAutoScan();
    }
  });

  serve({
    'scan:start': async ({ source }) => ({ runId: await startScan(source) }),

    'scan:cancel': async () => ({ cancelled: await cancelScan() }),

    'scan:status': async () => ({ run: await scanStatus() }),

    'shelf:sync': async ({ goodreadsId, shelves }) => {
      const result = await syncShelves(goodreadsId, shelves);
      await patchSettings({ goodreadsId, selectedShelves: shelves });
      return { entries: result.entries };
    },

    'shelf:listShelves': async ({ goodreadsId }) => ({
      shelves: await listShelves(goodreadsId),
    }),
  });
});

async function ensureAutoScanAlarm(): Promise<void> {
  const existing = await browser.alarms.get(AUTO_SCAN_ALARM);
  if (!existing) {
    await browser.alarms.create(AUTO_SCAN_ALARM, {
      periodInMinutes: AUTO_SCAN_PERIOD_MIN,
      delayInMinutes: AUTO_SCAN_PERIOD_MIN,
    });
  }
}

async function maybeAutoScan(): Promise<void> {
  const settings = await getSettings();
  if (!settings.autoScanEnabled || !settings.goodreadsId) return;
  if (settings.libraries.filter((l) => l.enabled).length === 0) return;

  try {
    await syncShelves(settings.goodreadsId, settings.selectedShelves);
    await startScan('auto');
    await patchSettings({ lastRunAt: Date.now() });
  } catch (error) {
    // A failed auto-scan must never leave state that blocks the next one.
    console.warn('[shelfmark] auto-scan failed', error);
  }
}
