/**
 * The provider registry.
 *
 * Adding a catalog platform means adding a file and one line here. Nothing
 * downstream — queue, storage, UI — learns its name. That is the whole point of
 * the `HoldingsProvider` interface, and it is what makes print support a matter
 * of writing adapters rather than rewriting the app.
 */

import type { HoldingsProvider } from '../core/types';
import { bibliocommonsProvider } from './bibliocommons';
import { overdriveProvider } from './overdrive';
import { polarisProvider } from './polaris';

const providers = new Map<string, HoldingsProvider>(
  [
    overdriveProvider,
    bibliocommonsProvider,
    polarisProvider,
    // Phase 5: aspenProvider, kohaProvider, sierraProvider
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
