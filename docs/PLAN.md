# agent-layer — build plan

Goes with [DESIGN.md](DESIGN.md). Engine decision: **headless Chrome now, own no-paint build later**.
Each phase ends green and measured before the next one starts. Behavior changes land with a failing
test first and before/after numbers.

## Where we are (31 Oct 2026)

Working: `open` / `do` / `verbs` over plain HTTP; live tabs over a daemon (`tab`, `read`, `click`,
`type`, `pick`, `press`, `go`, `back`, `net`); sessions; paging. 13 tests green. Benchmarks in
`bench/`.

Heuristics still in the code, and the phase that removes each:

| Current code | Removed in | Replaced by |
|---|---|---|
| ~~`snapshot.ts` `roleOf` / `nameOf`, `isRow`, `destOf`, name caps, `data-al`, blink image flag~~ | P1 ✅ | Reader on DOMSnapshot + accessibility tree, renderer policy, node-id refs, decoration blocked |
| 400 ms quiet `settle` | P2 | Settle contract, DESIGN §5.3 |
| `NOISE` regex | P3 | Engine resource types + tracker list data file |
| `page.ts` form reader, node-html-parser | P5 | parse5 + HTML form submission algorithm |
| `cookies.json` | P5 | `http` engine uses the browser profile's cookies |

## P0 — Foundations ✅ (31 Oct 2026)

- `src/policy.ts`: every behavior tunable, overridable from `<home>/policy.json`; wrong keys or values
  are errors. Daemon numbers now come from it.
- Corpus: HN, Google Flights results, GitHub repo, Amazon search, TodoMVC recorded as HAR under
  `test/corpus/` (`npm run record`), cookies and auth headers removed, replayed fully offline.
  `Math.random` is seeded on record and replay so pages rebuild the same request ids.
- `npm run measure`: reader time, lines, chars, refs, and per-page facts from `pages.json`; exits 1
  when a fact is missing. Baseline in `bench/results/baseline.json`.

**Done:** 16 tests green; every corpus page replays offline with all its facts. `src/` 1,059 → 1,095
lines (policy loader +35).

## P1 — Reader ✅ (31 Oct 2026)

- `src/reader.ts`: DOMSnapshot + accessibility tree → `Node` tree (DESIGN §4.1–4.2); refs are small
  numbers mapped to browser node ids. `src/render.ts`: lines by CSS display and row roles, headings,
  paging, `render.*` policy.
- `src/act.ts`: click, fill and pick on node ids with trusted input (scroll into view, box, hit test).
  Playwright locators are gone from actions.
- Images, fonts and media are never requested; animations play at 1000× and `prefers-reduced-motion`
  is on.
- `snapshot.ts` deleted.

**Done:** every corpus fact present (Flights now 61 of 61 rows); read max 121 ms (Flights) against the
150 ms budget; a test proves reading causes zero DOM mutations; 17 tests green; live Google Flights
search works end to end. `src/` 1,095 → 1,173 lines (`act.ts` +63: Playwright cannot act on a node id).

Moved: frames to P3, with windows and pop-ups, since acting inside a cross-origin frame needs that
frame's own engine session.

Open question: Flights text grew 20.6k → 33.5k chars because `render.nameChars` is 120 (the old
hard-coded cap was 45). One number trades completeness for tokens.

## Token budget ✅ (31 Oct 2026, pulled forward from P2)

Measured first: on the live Flights task the agent received 50,022 chars over 9 steps; on the Flights
page 65% of the text was control names, 62% hidden screen-reader labels.

- Actions answer with changed lines only (DESIGN §4.4); the view is per context, so a dialog opening
  and closing does not resend the page; refs survive pushState navigations.
- Hidden labels capped at `render.labelChars` (40); names that are on screen keep 120.
- An open modal dialog is the whole view.

**Result:** Flights task 50,022 → 31,349 chars (−37%); Flights page 33.5k → 20.1k (−40%); all corpus
facts present; 23 tests green. `bench/flights-task.sh` reproduces the task numbers.

## Map first ✅ (31 Oct 2026)

DESIGN §1a: a page opens as a map of its ARIA regions (fields with values, options, actions, headings,
collections with item count and first item, links; named when few, counted when many). `read <ref>`
opens one region, `read` the whole page. After an action the answer is the changed lines unless the
map is smaller (replaces the `render.deltaShare` share rule, which hid small-page results).

**Result:** map vs whole page on the corpus — Flights 2.1k vs 20.2k, Amazon 2.9k vs 22.4k, GitHub 1.5k
vs 17.5k, HN 0.2k vs 8.8k. Live Flights task including reading the results: 26,977 chars (start of the
day: 50,022). Navigation steps 10.8k; the results themselves 16.2k, which is the data layer's job.

## Next — Data layer

`get <collection>`: the records behind a page as rows with named columns, sortable and limited.
Source 1: the API responses the page loaded, fields named by matching their values to text on screen.
Source 2: the collection's rows when there is no API. Target: "cheapest flight" in a few hundred chars.

## P2 — Actions and settle

- Actionability with named failure reasons; trusted input for every pointer and keyboard command in
  DESIGN §6.
- Settle contract with reported reason.

**Exit:** a never-quiet page reports `deadline` within the policy deadline; a fetch page reports
`idle`; every action on the corpus returns a delta smaller than a full read.

## P3 — Events, windows, files, network

- Dialogs surfaced and answered; pop-ups and `target=_blank` as tabs; downloads saved and listed;
  `upload`.
- Frames, same-origin and cross-origin, read and acted in through their own sessions (DESIGN §4.2 rule 6).
- HAR logging with redaction; tracker list as data; `net show`.

**Exit:** a fixture with `confirm()`, a pop-up OAuth window, a download and an upload passes end to
end; no secrets in any file on disk.

## P4 — Reveal map

- ARIA and HTML reveal sources; CSSOM `:hover` / `:focus-within` analysis; document-start listener
  hook; `hover` / `focus` return what appeared.
- Canvas text hook.

**Exit:** fixtures for each source (ARIA menu, `<details>`, CSS hover menu, JS hover menu, render-on-
hover menu) show their items before any trigger, or are marked when they cannot be known; a canvas
fixture's drawn text is readable.

## P5 — The `http` engine on the specs

- parse5, HTML-AAM roles, the form submission algorithm, shell detection, cookies through the browser
  profile.

**Exit:** form-submission conformance cases pass; static corpus pages give the same roles and names on
both engines.

## P6 — Coverage and hardening

- Remaining DESIGN §6 commands: frames, storage, `eval`, permissions, profiles, Chrome cookie import.
- Live checks (`npm run live`) on the five benchmark sites plus a logged-in Gmail task.

**Exit:** every row in DESIGN §6 has a passing test; live checks green.

## Later — own the engine

`chrome-headless-shell`, then a build with paint, raster and compositing removed after layout.
Starts when measured CPU per tab at our target parallelism says the 70–220 ms per load matters.
