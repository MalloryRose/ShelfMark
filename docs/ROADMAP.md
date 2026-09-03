# Roadmap — phases 2 to 6

Implementation spec for whoever (or whatever) picks this up next. Each phase
lists its goal, the files involved, **verified** API shapes, the traps, and what
"done" means.

Read [`../CLAUDE.md`](../CLAUDE.md) first — its seven invariants apply to every
phase and several of them are non-obvious.

**Status:** phase 1 complete. Phase 2 is next and unblocks phase 3.

Anything marked **verified** was requested live against the real endpoint.
Anything marked **unverified** needs a spike before you design against it.

---

## Phase 1 — remaining tasks

Small, self-contained, good warm-up work. None block phase 2.

- [ ] **Shelf picker UI.** `shelf:listShelves` is wired end to end and returns
      `Record<shelfName, count>`; nothing calls it. Popup should list shelves as
      toggles with counts, persisting to `settings.selectedShelves`.
- [ ] **CSV import UI.** `src/shelf/goodreads-csv.ts` parses correctly and is
      untested by a UI. Add a file input; on parse, `putShelfEntries()` then
      `rebuildWorks()`. Report `skipped` honestly ("imported 340 of 347").
- [ ] **Multi-library management.** Storage models `LibraryConfig[]`; the popup
      writes exactly one and overwrites it. Add/remove rows, each with its own
      runtime permission request.
- [ ] **Toolbar badge.** Available count via `browser.action.setBadgeText`, set
      on `scan:complete`. Cheapest retention mechanic available.
- [ ] **OverDrive fixture tests.** Record a real Thunder response to
      `src/providers/__fixtures__/thunder-dune.json` and assert `lookup()` maps
      it correctly, including the reject path for a wrong-author result.

---

## Phase 2 — Identity and matching

**~2 weeks. Nothing visible ships. Everything after depends on it.**

### Why

A library owns whichever edition it bought in 2003, not the one on the reader's
shelf. Matching a single ISBN finds almost nothing; matching the *edition
cluster* is what makes print lookups viable. This phase also replaces the
deliberately-crude `isPlausibleMatch()` in `overdrive.ts` with a real score.

### Files

| Action | Path |
| --- | --- |
| create | `src/identity/openlibrary.ts` — API client |
| create | `src/identity/resolver.ts` — `ShelfEntry` → `WorkIdentity` |
| create | `src/lib/similarity.ts` — token-set ratio + scoring |
| create | `src/identity/*.test.ts`, `src/lib/similarity.test.ts` |
| create | `src/identity/__fixtures__/labelled-shelf.json` — 200 hand-labelled entries |
| modify | `src/shelf/sync.ts` — `toWork()` becomes async, delegates to resolver |
| modify | `src/core/db.ts` — add an `identityCache` store |
| modify | `src/providers/overdrive.ts` — swap `isPlausibleMatch` for the scorer |

### Verified endpoints

**ISBN → work key**
```
GET https://openlibrary.org/isbn/9780441013593.json
→ { "works": [{ "key": "/works/OL893414W" }], "isbn_13": [...], ... }
```

**Work → ISBN cluster.** Two routes; prefer the second.

```
GET https://openlibrary.org/works/OL893414W/editions.json?limit=3
→ { "size": 161, "entries": [{ "key", "title", "isbn_13": [...], "publish_date" }] }
```
161 editions for *Dune*, paginated — that is a lot of round trips.

```
GET https://openlibrary.org/search.json?q=dune&fields=key,title,author_name,isbn&limit=2
→ { "numFound": 144,
    "docs": [{ "key": "/works/OL893414W", "title": "Dune", "isbn": [ ...250 items ] }] }
```
**Use this one.** It returns the full cluster in a single request. The
`editions.json` walk is a fallback for when `search.json` misses.

**No ISBN on the shelf entry** — same endpoint, title+author:
```
GET https://openlibrary.org/search.json?title=dune&author=herbert&limit=1&fields=key,title,author_name,isbn
```

### Traps

- **250 ISBNs is too many to query a catalog with.** Select, don't dump: prefer
  `isbn_13`, prefer editions in the user's language, cap at ~20. Put the
  selection in one documented function — it is a quality knob you will tune.
- **Work-key migration.** `workId` changes from `local:dune|herbert` to
  `OL893414W`. Existing users have holdings keyed on the old id. Either write a
  migration that rewrites both stores, or version the DB and force one re-scan.
  Decide deliberately; silently orphaning everyone's data is the bad outcome.
  `localWorkId()` is namespaced `local:` precisely so you can tell them apart.
- **Open Library is rate-limited and sometimes slow.** Route through
  `hostLimiter`, cache resolutions **permanently** (bibliographic data does not
  expire), and degrade to the local work id rather than failing a scan.
- **`search.json` can return a different work than the reader meant** for common
  titles. Score its result too — do not trust it because it came from an API.

### Scoring

A candidate is accepted only if **both** hold:
- normalised title token-set ratio ≥ threshold (start at 0.85, then tune), and
- author surname matches exactly (`authorSurname()`).

Keep the threshold a named constant. It is the single number that trades false
positives against missed books, and phase 4's UI will make its effects visible.

### Done when

- `npm test` covers the resolver against recorded fixtures, offline.
- The 200-entry labelled set reports precision and recall as printed numbers.
- Recorded baseline: precision ≥ 0.95 (a wrong "available" is worse than a miss).
- A resolution failure degrades one book, never the scan.

---

## Phase 3 — First print provider

**~3–4 weeks. This is the reason the project exists.**

### Why

BiblioCommons powers many of the largest North American public library systems,
so one adapter buys more coverage than any other single piece of work.

### Files

| Action | Path |
| --- | --- |
| create | `src/providers/bibliocommons.ts` |
| create | `src/providers/__fixtures__/bibliocommons-*.html` |
| create | `src/core/library-registry.ts` + `src/assets/libraries.json` |
| create | `src/ui/library-search.tsx` — search by name or ZIP |
| modify | `src/providers/index.ts` — register the adapter |
| modify | popup — library search replaces the raw URL field |

### Verified

A BiblioCommons search page embeds a Redux preloaded state containing a `bibs`
map. Real fields observed on `seattle.bibliocommons.com`:

```
bibs: { "S30C3750420": {
  id, sourceLibId,
  briefInfo: {
    title, authors: [...], callNumber: "SCI-FIC HERBERT 2019",
    format, publicationDate,
    jacket: { small, medium, large }
  } } }
```

Cost: **~700 KB of HTML per query.** Cache hard, and never query per-edition.

### Unverified — spike these first

- The exact search URL for an identifier lookup. `/v2/search?query=…&searchType=…`
  renders, but confirm which `searchType` value takes an ISBN.
- Whether a lighter JSON endpoint exists. The page references a
  `BC_API_GATEWAY_URL` global — worth an hour before committing to HTML parsing.
- Where per-branch availability and due dates live in the state blob. The bib
  record has the call number; availability may need a second request.

### Traps

- **No `DOMParser` in a service worker.** The payload is JSON inside HTML —
  extract the blob with a regex, then `JSON.parse`. Do not regex the *fields*.
  If a later adapter needs real markup parsing, bundle `htmlparser2`.
- **Set `status` honestly.** `not-held` and "we could not tell" are different;
  never report the second as the first.
- **`callNumber` and `branches` are print-only** and stay `undefined` for
  digital. Do not fill them with empty strings.
- **Permissions.** Call `requestLibraryPermission()` before the first fetch to a
  new catalog origin. The plumbing exists in `src/core/settings.ts`.

### Library registry

Bundle a curated `libraries.json` — `{ id, name, city, state, providerId,
baseUrl, providerKey }` — for the largest systems. Ship it in the extension and
update it on release; **no backend in v1**. Include a "my library isn't listed"
path that accepts a raw catalog URL and runs `provider.detect()`.

### Done when

- A print holding with a real call number renders next to an OverDrive ebook
  holding for the same work, in one card.
- Adapter tests run against recorded fixtures with no network.
- Adding a library asks for its origin at that moment, and a fresh install can
  reach no catalog at all.

---

## Phase 4 — Interface

**~3 weeks. Where it stops feeling like a script.**

### Files

| Action | Path |
| --- | --- |
| create | `src/entrypoints/dashboard/` — full extension page |
| create | `src/ui/WorkCard.tsx`, `src/ui/FilterRail.tsx`, `src/ui/EmptyState.tsx` |
| modify | popup — reduce to triage only |

### The work card

One card per **work**, holdings as status rows beneath it. This is the central
change: the reference product renders one card per *copy*, so a book held in
three places appears three times.

```
┌──────────────────────────────────────────────┐
│ ▌ Dune                            💎 Rare    │
│ ▌ Frank Herbert                              │
│ ▌ to-read · added 12 Mar                     │
│                                              │
│   PRINT  On shelf   Central · SCI-FIC HERBERT│
│   EBOOK  Available  Seattle · 1 of 4         │
│   AUDIO  3 wk wait  Seattle · 14 in queue    │
│   PRINT  Not held   King County              │
└──────────────────────────────────────────────┘
```

Format left, status as the emphasis, and the detail that only matters for that
format on the right — a call number for print, a queue depth for digital.

### Requirements

- **Popup = triage.** "9 of 312 available now · 2 new since yesterday", the new
  covers, and a link to the dashboard. Nothing that needs scrolling.
- **Dashboard = browsing.** Left rail filters (shelf, library, format, status),
  each showing a count so nothing dead-ends. Grid and dense-list views.
- **Pick list.** The dense list grouped by branch with call numbers in mono is a
  printable trip list. Cheap; nothing else ships it.
- **Sort:** available → shortest hold → recently shelved. Rare and New float
  within their band.
- **Virtualise** the list. 500 works must stay at 60fps.
- **Four distinct empty states:** scanning, nothing available, catalog
  unreachable, shelf empty. They are four different situations.
- **Dark mode from tokens.** Every colour defined on bare `:root` first; the
  media query only *redefines*. A colour whose only definition sits inside a
  media query is the classic unreadable-in-one-theme bug.
- **Accessibility:** keyboard reachable throughout, visible focus, every icon
  labelled, `prefers-reduced-motion` respected. The reference build's nav is two
  unlabelled icon links — do not reproduce that.

---

## Phase 5 — Breadth

**Ongoing. Driven by user requests, not by guessing.**

- Adapters: **Aspen Discovery**, **Koha**, **Polaris/Sierra**, **SirsiDynix
  Enterprise**. Aspen and Koha document search APIs but the demo hosts tried
  returned `403` and a connection failure — spike each against a real member
  library before designing.
- **Generic detector.** `provider.detect(catalogUrl)` fingerprints an unknown
  catalog from its markup so users can paste any URL.
- **Adapter health.** Per-adapter success rate, surfaced to you, not to users.
  Scraping breaks; the question is whether you find out before a support email.
- **More shelf sources.** StoryGraph (CSV export) and Hardcover (GraphQL API).
  Real demand as Goodreads decays. `ShelfEntry` already fits both.

---

## Phase 6 — Launch

- **ExtensionPay.** No backend, no PCI surface. Right call for a solo launch.
- **Pricing.** Free: one library, all shelves, ≤300 works, manual scan, full
  print + digital results. Pro: unlimited libraries and works, daily auto-scan,
  new-availability and hold-drop notifications, multi-source shelves, pick-list
  export. **$29 lifetime or $2.49/month**, leading with lifetime.
  Do **not** cap free users below the point where the core promise still works —
  a 100-book cap breaks the product for exactly the reader most likely to pay.
- **Store listing.** Privacy policy is required. Justify each permission;
  `optional_host_permissions` is the strong part of that story.
- **Analytics.** Port the reference event taxonomy — it was well designed — but
  send the *provider platform*, never the library domain, which narrows a user
  to a locale. Do not ship the measurement secret in the bundle.
- **Firefox and Edge.** `npm run build:firefox` already produces a working build.

---

## Reference

The prior art is `../library-scan` (isaacbock/library-scan v2.0.0). Its product
decisions are mostly right and several are carried over deliberately: Goodreads
auto-detect, the Rare and New badges, idle-aware notifications, error backoff,
scan-generation cancellation. Its *architecture* is what this project replaces.
Read it for judgement, not for patterns.
