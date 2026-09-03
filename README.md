# Shelfmark

Your reading list, filtered by what's actually on the shelf — print, ebook and audiobook, across every library card you hold.

> **Status: phase 1 of 6.** The pipeline runs end to end against OverDrive.
> Print catalogs arrive in phase 3; see [Roadmap](#roadmap).

## Why this exists

Existing tools answer *"is this book at my library?"* while you're already looking at it.
Shelfmark answers the harder question: **"of the 312 books I want to read, which can I get today?"** —
and it checks print holdings, not just digital.

## Quick start

```bash
npm install          # also runs `wxt prepare` to generate types
npm run dev          # launches Chrome with the extension loaded, HMR on
```

Then in the popup: paste a Goodreads profile URL → **Sync**, enter an OverDrive
address (`lapl.overdrive.com`) → **Add**, then **Scan my libraries**.

| Command | Does |
| --- | --- |
| `npm run dev` | Chrome dev build with hot reload |
| `npm run dev:firefox` | Same, targeting Firefox |
| `npm run build` | Production build → `.output/chrome-mv3/` |
| `npm run build:firefox` | Production build → `.output/firefox-mv2/` |
| `npm run compile` | Typecheck only |
| `npm test` | Vitest |
| `npm run zip` | Store-ready archive |

## How it's put together

Three stages that meet at one normalised record, so adding a catalog platform
never reaches the UI.

```
Shelf sources          Identity resolver        Holdings providers
─────────────          ─────────────────        ──────────────────
Goodreads RSS   ─┐                          ┌─  OverDrive (Thunder API)
Goodreads CSV   ─┴──→  WorkIdentity  ──────→│   BiblioCommons   (phase 3)
                       ISBN cluster         └─  Aspen · Koha    (phase 5)
                                                       ↓
                                                    Holding
                                                       ↓
                                              work-grouped UI card
```

```
src/
├─ core/
│  ├─ types.ts        Holding, WorkIdentity, ScanTask — the shared vocabulary
│  ├─ db.ts           IndexedDB: works, holdings, shelf entries, queue
│  ├─ scan-queue.ts   Resumable scan (read this one first)
│  ├─ messages.ts     Typed request/response bus
│  └─ settings.ts     chrome.storage.local + runtime host permissions
├─ providers/         One file per catalog platform
├─ shelf/             Reading-list ingestion + work resolution
├─ lib/               http (timeouts, rate limiting), normalize (pure)
└─ entrypoints/       background · popup · goodreads content script
```

### Three decisions worth knowing about

**The scan is a queue, not a loop.** Chrome kills an extension service worker
when a single event exceeds five minutes, and when any `fetch()` takes longer
than 30 seconds. A scan driven from one message handler *is* one event. So every
task is persisted before any network call, each tick does bounded work and hands
back control, and `chrome.alarms` brings us back. Termination is a pause, not a
failure. See `core/scan-queue.ts`.

**No provider shape reaches the UI.** OverDrive's `firstCreatorName` and a
BiblioCommons call number both normalise to `Holding` or they don't land at all.
`callNumber` and `branches` are optional because a digital loan genuinely has
neither — the type says so rather than faking empty strings.

**Catalog origins are requested at runtime.** `optional_host_permissions` means a
fresh install can reach no library catalog until you add one. Better for store
review, and true in a way users can verify.

## Testing

Pure layers get unit tests; adapters get **recorded fixtures**. That second part
isn't optional polish — when a catalog changes its markup, a fixture test is how
you find out instead of a support email.

```bash
npm test
```

## Roadmap

| Phase | | |
| --- | --- | --- |
| 1 | Foundation + digital parity | **in progress** |
| 2 | Open Library resolver, ISBN clusters, match scoring | next |
| 3 | BiblioCommons adapter — first print holdings | |
| 4 | Full dashboard, work-grouped cards, dark mode, a11y | |
| 5 | Aspen · Koha · Polaris adapters, StoryGraph/Hardcover | |
| 6 | Pricing, store listing, Firefox + Edge | |

### Phase 1 remaining

- [ ] Shelf picker UI (`shelf:listShelves` is wired; nothing calls it yet)
- [ ] CSV import UI (`shelf/goodreads-csv.ts` parses; no file input yet)
- [ ] Multi-library management (storage handles many; popup writes one)
- [ ] Toolbar badge with the available count
- [ ] Fixture tests for the OverDrive provider

## Notes

Not affiliated with Goodreads, OverDrive or any library system. Reads only
publicly available pages, on the user's behalf, for libraries they choose.

Goodreads retired its API in 2020 and the RSS feed is undocumented — which is
why CSV import ships as a first-class source rather than a fallback bolted on
later.
