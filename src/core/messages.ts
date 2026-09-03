/**
 * A typed request/response bus over chrome.runtime messaging.
 *
 * The reference implementation passes stringly-typed messages and swallows
 * every send failure with `.catch(() => {})`, so a popup that missed an update
 * silently shows stale state. Here the contract is a type, and "nobody is
 * listening" is an expected outcome with a name rather than a swallowed error.
 */

import { browser } from '#imports';
import type { ScanRun } from './types';

export interface ScanProgress {
  runId: string;
  total: number;
  done: number;
  failed: number;
  /** What the user should be told we're doing right now. */
  label: string;
}

/** Popup → background. Each key maps a request shape to a response shape. */
export interface Requests {
  'scan:start': { req: { source: 'manual' | 'auto' }; res: { runId: string } };
  'scan:cancel': { req: Record<string, never>; res: { cancelled: boolean } };
  'scan:status': { req: Record<string, never>; res: { run?: ScanRun } };
  'shelf:sync': { req: { goodreadsId: string; shelves: string[] }; res: { entries: number } };
  'shelf:listShelves': { req: { goodreadsId: string }; res: { shelves: Record<string, number> } };
}

/** Background → popup. Fire-and-forget; nobody may be listening. */
export interface Events {
  'scan:progress': ScanProgress;
  'scan:complete': { runId: string; available: number };
  'scan:failed': { runId: string; reason: string };
}

export type RequestKind = keyof Requests;
export type EventKind = keyof Events;

interface Envelope {
  __shelfmark: true;
  kind: string;
  payload: unknown;
}

function envelope(kind: string, payload: unknown): Envelope {
  return { __shelfmark: true, kind, payload };
}

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && '__shelfmark' in value;
}

/** Thrown when the background worker returned an error for a request. */
export class MessageError extends Error {
  constructor(readonly kind: string, message: string) {
    super(`${kind}: ${message}`);
    this.name = 'MessageError';
  }
}

export async function send<K extends RequestKind>(
  kind: K,
  payload: Requests[K]['req'],
): Promise<Requests[K]['res']> {
  const reply = (await browser.runtime.sendMessage(envelope(kind, payload))) as
    | { ok: true; value: Requests[K]['res'] }
    | { ok: false; error: string }
    | undefined;

  if (!reply) throw new MessageError(kind, 'no response from background worker');
  if (!reply.ok) throw new MessageError(kind, reply.error);
  return reply.value;
}

export type RequestHandlers = {
  [K in RequestKind]: (payload: Requests[K]['req']) => Promise<Requests[K]['res']>;
};

/**
 * Register every request handler at once. Exhaustive by construction — adding
 * a key to `Requests` fails the build until it is handled.
 */
export function serve(handlers: RequestHandlers): void {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isEnvelope(message)) return false;

    const handler = handlers[message.kind as RequestKind];
    if (!handler) return false;

    // Errors cross the boundary as data. An exception here would otherwise
    // surface to the popup as an opaque "message port closed".
    handler(message.payload as never)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );

    return true; // keep the channel open for the async response
  });
}

/**
 * Broadcast to any open extension page.
 *
 * A closed popup is the normal case, not a failure — during a background scan
 * there is usually nothing listening. We drop those quietly but deliberately.
 */
export async function emit<K extends EventKind>(kind: K, payload: Events[K]): Promise<void> {
  try {
    await browser.runtime.sendMessage(envelope(kind, payload));
  } catch {
    // No receiver. Expected whenever the popup is shut.
  }
}

export function onEvent<K extends EventKind>(
  kind: K,
  handler: (payload: Events[K]) => void,
): () => void {
  const listener = (message: unknown) => {
    if (isEnvelope(message) && message.kind === kind) {
      handler(message.payload as Events[K]);
    }
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
