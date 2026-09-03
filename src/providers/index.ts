/**
 * The provider registry.
 *
 * Adding a catalog platform means adding a file and one line here. Nothing
 * downstream — queue, storage, UI — learns its name. That is the whole point of
 * the `HoldingsProvider` interface, and it is what makes print support a matter
 * of writing adapters rather than rewriting the app.
 */

import type { HoldingsProvider } from '../core/types';
import { overdriveProvider } from './overdrive';

const providers = new Map<string, HoldingsProvider>(
  [
    overdriveProvider,
    // Phase 3: bibliocommonsProvider  — print, largest coverage per adapter
    // Phase 5: aspenProvider, kohaProvider, polarisProvider
  ].map((p) => [p.id, p]),
);

export function getProvider(id: string): HoldingsProvider | undefined {
  return providers.get(id);
}

export function listProviders(): HoldingsProvider[] {
  return [...providers.values()];
}

export function registerProvider(provider: HoldingsProvider): void {
  providers.set(provider.id, provider);
}
