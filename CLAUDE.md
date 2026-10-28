# Shelfmark — agent brief

Chrome/Firefox extension (MV3). Scans a reader's to-read list against the
libraries they hold cards for and reports what is **available right now** —
print, ebook and audiobook.

**Phase 1 of 6 is complete.** The full spec for phases 2–6 is in
[`docs/ROADMAP.md`](docs/ROADMAP.md). Read the phase you are implementing there
before writing code — it carries verified API shapes and the traps.

## Commands

```bash
npm run dev        # Chrome + HMR (launches its own browser; see README)
npm test           # Vitest
npm run compile    # tsc --noEmit
npm run build      # production build → .output/chrome-mv3/
```

Before claiming any task done: `npm run compile && npm test && npm run build`.

## Architecture in one paragraph

Three stages meet at one normalised record. **Shelf sources** (`src/shelf/`)
produce `ShelfEntry`. The **identity resolver** (`src/shelf/sync.ts`, becoming
`src/identity/` in phase 2) turns those into `WorkIdentity` — a *work*, not an
edition, carrying an ISBN cluster. **Holdings providers** (`src/providers/`) take
a `WorkIdentity` plus a `LibraryConfig` and return `Holding[]`. The scan queue
(`src/core/scan-queue.ts`) drives it; IndexedDB (`src/core/db.ts`) stores it.

## Invariants — do not break these

1. **No provider response shape may escape `src/providers/`.** Everything
   normalises to `Holding` (`src/core/types.ts`) or it does not land. If you find
   yourself reading `firstCreatorName` outside `overdrive.ts`, stop. This is what
   makes print adapters additive instead of a rewrite.

2. **The scan must stay resumable.** Chrome kills an extension service worker
   when a single event exceeds 5 minutes or a `fetch()` exceeds 30 seconds.
   Persist task state *before* the network call, keep tick work bounded, resume
   via `chrome.alarms`. Never hold scan state in module scope — it does not
   survive termination. See the header comment in `src/core/scan-queue.ts`.

3. **Never set a fetch timeout above 20s** (`MAX_FETCH_MS` in `src/lib/http.ts`).
   Above 30s Chrome kills the worker before your `catch` block runs.

4. **Route every outbound request through `hostLimiter`.** Hundreds of rapid
   requests to one library catalog is how you get firewalled.

5. **Catalog origins are requested at runtime** via `optional_host_permissions`
   and `requestLibraryPermission()`. Never add a catalog host to static
   `host_permissions`.

6. **Verify a result matches the book before accepting it.** A false "available
   now" sends someone to the library for a book that is not there. Title
   agreement *and* author surname agreement, both required.

7. **ISBNs are validated, never trusted.** Use `toIsbn13()`. A bad ISBN returns
   zero holdings, which is indistinguishable from "the library doesn't own it".

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess` on. No `any`, no non-null `!` on
  values that can genuinely be absent.
- Pure logic lives in `src/lib/` and is unit tested. Adapters are tested against
  **recorded fixtures** — that is how you learn a catalog changed its markup
  before a user tells you.
- Comments explain *why*, especially where the code looks odd because of an MV3
  constraint or a third-party quirk. Do not narrate what the code does.
- No new dependency without a reason that survives "could this be 40 lines?"
  The bundle ships to users.

## Context worth having

- **Goodreads** retired its API in 2020. The RSS feed is undocumented and may
  vanish; CSV import exists so that is an inconvenience, not an outage.
- **Print catalogs.** BiblioCommons has a JSON gateway; Polaris PowerPAC is
  session-based HTML whose availability endpoint keys on result *position*,
  not record id. Read "Print adapters — as built" in the roadmap before
  touching either.
- **OverDrive Thunder** (`thunder.api.overdrive.com`) needs no auth but is
  unpublished. It does **not** index ISBNs — digital lookups go out as
  title+creator, print catalogs get the ISBN cluster. Conflating the two finds
  nothing, silently.
- **The competitor** is Library Extension: free, ~3200 library systems, answers
  "is *this* book available?" while you browse. We answer "which of my 312
  to-read books can I get today?" Do not drift toward page decoration.
