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

## P2 — Actions and settle

- Actionability with named failure reasons; trusted input for every pointer and keyboard command in
  DESIGN §6.
- Settle contract with reported reason; deltas returned by every action.

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
