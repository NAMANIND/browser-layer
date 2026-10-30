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

## Data layer, part 1 ✅ (31 Oct 2026)

`get <ref>` (DESIGN §4.5): tables by the HTML table model with header names, lists by field paths,
numeric sorting, limits, column picks, TSV out. Collections have refs in the map; table counts exclude
the header row.

**Result:** live Google Flights task, open to "3 cheapest flights", 12,789 chars (start of the day:
50,022); the answer matches Google's own "cheapest from ₹6,475". GitHub's file table comes out as 25
records with named columns. 25 tests green; corpus facts all present. `src/` 1,352 → 1,493 lines
(`data.ts` 92 lines; reader, render, CLI and daemon +49).

## Data layer, part 2 ✅ (31 Oct 2026)

1. **Unmarked collections** (DESIGN §4.5): data-region detection with `data.minRepeats` / `data.minParts`;
   template-not-identity for classes. Amazon's 16 products are records with aligned title and price
   columns; HN's table and Flights' lists unchanged. 26 tests green.
2. **The page's own data as a record source — decided against for now**, from a spike:
   - Google Flights' data on load is embedded in the HTML (`AF_initDataCallback`, 110 KB), not in an API
     call; it is locatable by matching values (an array of 56 flights and one of 5, as the page shows) but
     positional, with no field names.
   - Every framework encodes it differently (`AF_initDataCallback`, `__NEXT_DATA__`, RSC payloads, Apollo
     state): supporting them is format-by-format code, against DESIGN §1 principle 1.
   - The standard form, schema.org JSON-LD or microdata, is absent on all five listing pages.
   - What the page shows is already records; anything else stays reachable by the agent through `net`.
   - Revisit: schema.org JSON-LD / microdata as named page facts, measured on a detail-page corpus.

## P2 + P3 + core commands ✅ (31 Oct 2026)

- Actions wait for readiness with named reasons; every answer says why settling stopped.
- Frames, same-origin and cross-origin, read and acted in.
- `alert` / `confirm` / `prompt` wait for `dialog accept|dismiss`; input that opens one ends the action.
- Pop-ups (`window.open`, `target=_blank`, OAuth) open as tabs in the opener's session and become current.
- Downloads saved and reported; `upload` through file inputs and file choosers.
- `scroll` (wheel, top, bottom; lazy rows come back as changes), `hover`, `dblclick`, `rightclick`,
  `wait [--gone]`, `forward`, `reload`, `eval`.
- Answers: changed lines; a replaced page answers with the shorter of its text and its map.
- `npm link` installs the `agent-layer` command.

**Result:** 33 tests green; corpus facts all present; live Google Flights task 12,418 chars with the
right answer. `src/` 1,551 → 1,822 lines.

Then (same day): `net` numbers requests and `net show <#>` gives headers (credentials redacted) and
bodies, which is what an agent needs to call an API itself; trackers are hidden by protocol (beacons,
204) plus a data file, replacing the `NOISE` regex; `allow <permission> [lat,lon]` grants per site;
`--profile <name>` is a separate browser. 36 tests green.

`login <url>`: a normal Chrome window on the agent's profile, signed in by the person; it uses the same
mock keychain as the agent's browser, without which the saved session cannot be decrypted. Chosen over
importing the person's Chrome cookies (that would copy every signed-in site and read the real keychain).
37 tests green.

`show` / `hide`: the agent's browser as a visible window a person can watch, or headless; the browser
restarts and every tab reopens in its session; it refuses to restart if the open tabs cannot be listed.
38 tests green.

P4 ✅: controls say what they reveal (aria-controls / aria-owns / popovertarget items, closed
<details>) and whether they react to hover (listener hook); 2D canvas text reads as lines (Sheets-style
grids). Live: Amazon's language menu shows its hidden options in the map. 41 tests green. Not covered:
CSS :hover rules, React's root-delegated listeners, WebGL text (Figma).


Exploring (DESIGN §4.3a): `explore [ref]` opens every declared menu and pop-up, reads what appeared,
closes it, never runs a command; `menu "A > B > C"` runs a path by names; the map shows closed-menu
counts and canvas content. Live on a Google Sheet, with no Google-specific code: the map shows the
40-line canvas grid and 20 closed menus; `explore` on File lists File > Download ▸ … CSV in 6.8 s;
`menu "File > Download > Comma-separated"` downloads the CSV. 42 tests green.


P6 ✅: `find`, `drag` (pointer and HTML drag and drop), `check` / `uncheck`, `submit`, `type --keys`,
`cookies` (values never shown), `storage`, `beforeunload` waits for the agent; DESIGN §6 matches what
is built. 46 tests green.


Real-use fixes ✅: settle waits for what the command caused, not standing connections (Sheets actions
5 s → 0.4–1.4 s); script-made clickable elements get refs (0–2 per page on real sites); `get` on a
canvas (rows by line, columns by text start; Sheets' mixed alignment and wrapped cells come out split,
documented). 48 tests green.


P5 ✅: the fast path parses with parse5 and renders through the same tree and renderer as live tabs
(a static page gives the same roles and names on both engines, tested); forms follow the HTML form
submission algorithm (conformance test: owners, disabled fieldset with legend exemption, submitter
overrides, dirname, multi-select, tree order, CRLF, text/plain); JavaScript-built pages say so.
`page.ts`, `view.ts` and node-html-parser removed. Decided against: reading Chrome's encrypted cookie
store directly (Chrome internals, not a standard); the two-way jar sync stays. 51 tests green.

Still open:
P5 fast path on parse5 and the HTML form submission algorithm.

## P2 — Actions and settle (superseded by the section above)

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
