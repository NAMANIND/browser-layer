# browser-layer — build plan

Goes with [DESIGN.md](DESIGN.md). Engine decision: **headless Chrome now, own no-paint build later**.
Each phase ends green and measured before the next one starts. Behavior changes land with a failing
test first and before/after numbers.


## Where we are (9 Nov 2026)

Published: 0.1.3 on npm. Release candidate: the branch `hardening` (0.1.4), which holds everything since 0.1.3:
parallel sessions, `tab <url…>`, `each`, `close --all`, `stop` in a named session closing only that session's tabs,
a client that waits for a daemon still starting Chrome, and answers cut by 4%. 112 of 113 tests pass (the one failure,
"switching the browser between visible and headless", also fails without these changes); `npm run measure` exits 0;
`src/` is 3,390 lines in 8 files (31 Oct baseline 1,059).

**Benchmark, 25 tasks the code was never tuned on (BU Bench V2.1, one run each, 9 Nov):**

| | Score | Money | Time | Timeouts | Points per $ |
|---|---|---|---|---|---|
| Browser Harness | 8.09 | $1.35 | 371 min | 3 | 0.409 |
| `hardening`, one agent per container | 7.58 | $1.34 | 360 min | 7 | 0.388 |
| `hardening`, 5 agents sharing a container (two runs) | 8.39 / 7.69 | $1.04 / $1.22 | 30 min each | 5 / 8 | 0.55 / 0.44 |
| 0.1.3 | 6.90 | $1.33 | 451 min | 2 | 0.355 |
| 0.1.2 | 5.69 | $1.46 | 395 min | 7 | 0.267 |

**Same agent, tool against tool (Codex, the 25 unseen tasks, one run each, 10 Nov):** Browser Use 1.0.0's own CLI (Browser
Harness helpers, 8.07, $1.41, 1,448 steps, 3 timeouts), our 0.1.4 (7.94, $1.50, 1,562 steps, 4 timeouts) and 0.1.4 with the
answer ceiling (9.51, $1.51, 1,638 steps, 1 timeout, 311 against 386 minutes). Scores are a tie: the paired differences are
+0.06 per task with a standard error of 0.05 to 0.07, better on 9 tasks and worse on 10 or 11. What is not noise: the ceiling cut
the tool's output from 5.57M to 3.51M characters (-37%), time by 19% and timeouts from 4 to 1, and input tokens fell 4%.
Money did not move, and steps rose 5% (agents slice the saved files); our input tokens are still 18% above their CLI's.
The ceiling is in `hardening`. Browser Use's own agent loop (not its CLI) led the tools by a wide margin in an earlier run,
so the gap that matters is the loop around the browser, not the tool.

**Same agent, two runs each, pooled (Codex, the 25 unseen tasks, 10 Nov):** Browser Use 1.0.0's CLI and our 0.1.4 with the answer
ceiling score alike (8.53 against 8.58; paired difference +0.002 per task, standard error 0.039; ours better on 8 tasks, theirs on
11). Their CLI is leaner by about a fifth on the long tasks: $1.31 against $1.58, 1,350 against 1,636 steps, 68M against 97M input
tokens, 6.5 against 5.4 points per dollar. Our timeouts swung between 1 and 6 across the two runs (theirs 3 and 2). The largest
step gaps are on tasks 091, 042, 037, 071, 029 and 049. One run per task cannot show these differences: run 1 had us ahead on
score, run 2 had them ahead.

**Why the long tasks take twice the commands (read from the transcripts of tasks 091, 042, 037, 071, 029 and 049, both runs, 10 Nov):**
our agent runs about 96 commands per long-task run against their 48. A third of ours (33 per run) are the agent's own shell: 59%
read a file our tool saved (`sed`, `rg`, `head`, `jq` on `--out` files; 81 straight after the save), and 33% run a script over such
files. Their agent fetches, filters and prints in one script, so that loop is one turn. Error and blocked answers are about 3 per run
(a site refusing the browser, a stuck page, a stale ref), a fraction of the gap. The skill itself tells the agent to save big results
to a file and then grep them, which is the loop. Two ways to close it: let an answer carry what the first look would have read, or let
one call fetch, filter and print.

**Browser mode (10 Nov, 24 tasks scored in all three, five agents sharing one browser per mode, 75 agents at once so absolute
scores are low):** our default launch 5.60, attached to a minimal headless Chrome (the Browser Harness way, `navigator.webdriver`
false) 5.55, attached to a visible Chrome on a virtual display 6.01. Scores are a tie (paired differences at most 0.02 per task, standard
error 0.04 to 0.06). Blocked pages: 14, 18 and 5. A visible Chrome meets fewer blocks, a headless one attached the Browser
Harness way does not (the five-task pilot's "half as many" for it was noise), and the score did not move. No change to the defaults.

On the 24 tasks it was tuned on, `hardening` looked far ahead of Browser Harness; on unseen tasks it is level. Two runs of
the shared layout differ by 0.7 points and 3 timeouts, so one run per task cannot show a 5% difference. Of the timeouts,
most are the agent's own shell loops fetching hundreds of pages one at a time (8 to 14 minutes in one command) and model
stalls, not the tool; stuck pages and a daemon restart under load are the rest.

Every heuristic the 31 Oct plan listed is gone: the 400 ms settle, the `NOISE` regex, `snapshot.ts`,
`page.ts`, node-html-parser. The old P2 to P6 sections said the same as the sections below and were removed.

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
- `npm link` installs the `browser-layer` command.

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

## Since 31 Oct ✅

- Releases 0.1.1 to 0.1.3: faster start, false blocks and hung pages fixed, answers shortened, refs that
  survive a re-render, each part of a site shown once, `help` shorter, pages open as maps again.
- **Attach** (`fc3d082`): the agent works in a person's own signed-in Chrome, in tabs of its own.
- **Sessions run side by side** (`0f252e5`): one command queue per session, per-session command state, the
  cookie jar read back only when changed from outside. Four slow sessions take as long as one.
- **`tab <url…>`** (`74003e7`): several pages load together and answer with each map.

**Benchmark, 24 tasks on both tools (BU Bench V2.1, one run each):**

| | Score | Money | Time | Timeouts |
|---|---|---|---|---|
| Deployed 0.1.3 | 6.69 | $1.32 | 360 min | 8 |
| `lean-answers` | 8.30 | $2.02 | 285 min | 3 |
| Browser Harness | 7.15 | $1.95 | 391 min | 7 |

Where the extra cost sits: each turn is heavier (input +63%, output +86%, reasoning +89%) while requests rose
only 14%; the cost clusters in runs over about 80 commands that read many pages one turn at a time. About
half of the lost score is sites refusing a headless browser, the same for both tools.

Tried and dropped: a note after 80 commands telling the agent to deliver what it has. It cut cost 54% on six
long tasks but cost score on four of them and did not rescue the two worst runaways.

## Open

Next phase, in order. Each starts with a failing test and reports numbers before and after.

1. ~~Many-page tasks.~~ Done on `hardening`: `each '<read>' <url…>` (three public pages, the old way took 7 calls and
   2.9k+ chars, `each` 1 call and 1.7k, and it leaves no tabs open). Not measured on the benchmark yet.
   Bulk (measured on a local fixture of 1 s pages, `find price` on each): a shell loop of `go` + `find` takes 15 s / 62 s / 154 s
   for 10 / 40 / 100 pages (2N calls); `each` took 3 / 8 / 18 s in one call, already. What was missing for hundreds of pages:
   all pages loaded at once, one 75 s limit on the whole call, and the answer inline (about 22k chars per call in the benchmark).
   Now `each.concurrency` (10) bounds the tabs, each page has its own limit, and `--out <file>` writes a line per page and
   answers in 180 chars: 10 / 40 / 100 / 300 pages in 4 / 7 / 18 / 51 s (unbounded was 37 s at 300, the price of bounding).
   Format (from 41 agent commands in 5 crawl tasks that read these files, 174k chars: `head -3` 35k, `rg -n` 43k, four single
   lines over 3k): `--out` now writes `== <address>  [status]` then the page's own lines, and the answer lists failures with
   reasons and 12 headlines (`bulk.*`). On a fixture of 41 pages of 17k chars: `head -3` 51.5k -> 162 chars, `rg -n needle`
   17.2k -> 141, `sed -n 1,40p` 692k -> 4.3k, the answer 182 -> 1.7k chars (it replaces the `head`/`wc`/`rg` follow-ups).
   No skill line yet: a fixture cannot show whether agents reach for `each --out`; add one if the next benchmark still has the loops.
2. **Smaller answers.** Mined from the 75 benchmark transcripts (fresh25-money1, shared25-money2, r6-hardening-4th; 12.6M
   characters of tool output) and replayed on the real answers. Done on `hardening`: the footer (`contentinfo`) is counted
   in the map, not named (-133k); an action names at most `render.mapFew` removed lines (-114k); the tab line is repeated
   only when it differs from the last answer (-154k); the command-hint footers are gone (-121k). Together about 520k, 4% of
   all output and 7% of map, action and read answers. Not done, with reasons: lowering `render.mapFew` (links saved 62k at 6,
   but 174 of 206 collapsed lists held a link the agent later used); focus-only diffs and an action diff repeated by the read
   after it (12 and 8 answers in 75 runs); download addresses (15). The largest piece is not in the renderer: 727 of 735 reads
   were `read --full`, which skips both "since your last read" and "shown before, unchanged", and 16% of read characters repeat
   lines of an earlier answer for the same address. `help` lists `--full` and agents use it from the first read (shared25-money2
   had no hint in any answer and still 151 of 179). Dropping it from `help` is a guess about the agent: only a benchmark run says.
3. **Tabs pile up** (median 5 a task, 90th percentile 22). Done on `hardening`: opening a page already open in the
   session switches to it, `tabs` lists by last use, `close --all` closes the session's tabs. A cap per session is not
   added: nothing measured says what the number should be.
4. **`get` on varied cards explodes into columns** (optional parts each make one). Needs a standard way to
   keep columns stable. Tried on paper with the snapshot's free `layout.bounds`: columns from each field's horizontal
   position in its row do not do it. Amazon's 16 stacked cards (22 path columns, 52% blank) collapse to one column
   (title, rating and price share an x); Flights' 57 rows go from 17 columns at 30% blank to 14 at 43% (fields that
   wrap or share an x merge or split). Not built; stacked cards would need vertical order, which is a different rule.
5. ~~A covered control costs a turn~~ Already handled: `pointAt` polls a covered control for the whole `actions.timeoutMs`
   (5 s) and answers `covered by …` only if the cover stays. Nothing to add: the 78 `cannot act on [N]: covered by`
   answers in 105 benchmark runs (4,986 commands, 38 runs) are covers that stayed 5 s (cookie and sign-in banners, ad
   blocker notices, carousels, canvases) and name the controls to click, so each costs one call. Marking covered controls
   in the map from `includePaintOrder` and bounds would save at most that call, and `elementFromPoint` is the exact test
   (pointer-events, clipping, overlays that open after the map). The snapshot's bounds and paint order cost nothing
   measurable (paint order: p50 within noise on five pages, payload +1 to 2%; `includeDOMRects`: +20 to 50% time,
   +15 to 20% payload); the reader reads neither. Viewport awareness: 55 `scroll` commands in 15 runs and no answer
   mentions a fold; not built.
6. ~~Parallel, what is left.~~ Done on `hardening`: `sessions.max` is enforced, the jar is written only when it changed,
   and a session unused for `sessions.idleMs` loses its tabs when another session runs a command.
7. **Sites refusing the browser.** Steer the agent to the site's API, sitemap or another source before it
   gives up. Headful against headless: parked until someone wants it measured.

Branch `hardening` (from `lean-answers`): a daemon that dies mid-command is no longer asked to run it again; a
request it cannot parse no longer kills it; `sessions.max` and `network.tabBytes` are enforced; an action that
repeats a call with the same answer says so (`note: the same call gave this same answer N calls ago`).

`npm run stress` (needs `STRESS_DIR`, a clone of browser-use/stress-tests; the pages are not in this repo) drives 13
of their challenges by command and passes when the page says it completed. The first pages showed real gaps in
the reader and in `type`/`pick`; now 18 of 18 (the last five, forms with hidden labels, Arabic labels, three nested iframes, a keystroke-eating input and a plain button, needed no code change): date, time and colour inputs,
`contenteditable` editing hosts, hover targets and scroll containers get refs; `type` sets date, time, colour
and range inputs; `pick` on a multiple select adds. Read time on the corpus is unchanged (scroll containers
are found in one in-page pass; asking the snapshot for element rects made reads 35–45% slower, so no).

Decided, no change: `steps` does not need to stop on a replaced page. A ref from before the change is gone from the new
page (refs only count up), so a later step that names one fails and the batch stops there with the page as it is; a
step that names a control by its words is meant to act on whatever page is then open, as the skill's examples do.
A timed-out command that keeps running is left alone: it ran against a page that stopped answering, each of its own
waits is bounded by `actions.timeoutMs`, and the error already tells the agent to close that tab and open it again.
Cancelling would thread a signal through every handler for a case no run has shown.

Not done: the library forms among the 60 stress-test pages.

Next, in order:
1. **Single-task baseline**, since the public benchmark runs one agent on one task: 3 runs of the 25 unseen tasks for the
   candidate, 0.1.3 and Browser Harness, one agent per container at low concurrency so CPU contention does not distort
   timing, logging tokens, steps and the split of wall time (the runner saves per-command timestamps, the daemon log and the
   container's memory record). Only this can show a gain of 5%.
2. **Timeouts** (7 of 25): read the loops and stalls the baseline shows before changing anything. Decided no change for
   now: a hint in the skill against crawl loops (the skill is re-read every turn, and the earlier "deliver what you have"
   note cost score on four of six tasks); revisit only if the baseline shows loops still the main cause.
3. **Idle close at 5 minutes** (`sessions.idleMs` from 15): parked. It would have hit 2 of 1,109 pauses in the benchmark; it
   only matters for browsers that stay up, not for one-task containers.

4. **Long reads to a file** (`answer.fileChars` 8000, `answer.headChars` 4000, DESIGN §4.4): built on the transcripts, not yet
   run on the benchmark. Estimate: 154 of 1,400 read/find/get answers in 75 runs are cut, 7% of all tool output and 6.7% of
   the characters the model re-reads across turns, before the extra turns for agents that need the cut part. Compare token
   and score on the next 25-task run before the release keeps it.

5. **One ceiling for every answer** (`answer.maxChars` 20000, DESIGN §4.4): the long-read file mechanism applied at the reply
   and to `open`'s printing. In 3,700 benchmark commands, 24 answers over 20k were this tool's alone and hold 4.2M of
   the 16.1M characters returned (26%); another 13 carry the agent's own `rg`/`sed` output (3.2M more). Not yet run on the
   benchmark: compare tokens and score on the next 25-task run.

Before any deploy: run the same 24 tasks twice more on the branch, because one run per task is noise.

Carried over:
- P6 exit: every row of DESIGN §6 has a passing test, and the live checks on the five benchmark sites plus a
  logged-in Gmail task pass. Not confirmed since 31 Oct.
- `render.nameChars` (120) trades completeness for tokens; unresolved.
- Revisit schema.org JSON-LD or microdata as page facts, once measured on a detail-page corpus.
- Reveal detection does not cover CSS `:hover` rules, React's root-delegated listeners or WebGL text.
- The benchmark's own notes (judge cost uncounted, model stalls, one run per task) are in
  `browser-layer-bench/bu-bench/NEXT.md`.

## Later — own the engine

`chrome-headless-shell`, then a build with paint, raster and compositing removed after layout.
Starts when measured CPU per tab at our target parallelism says the 70–220 ms per load matters.

Branch `lift-keep` (from `hardening`): what was kept of the less-lifting work. Two same-agent Docker runs of 5 tasks per arm
(10 task runs each) showed no gain for the whole of it: pooled score 23.5 against 20.2 (one task, bu2-079, carries it),
steps 503 against 498, carried characters 30.5M against 26.3M, and the direction differed between the runs. `find --in` was used
10 times in one run and never in the other and cut neither steps nor characters; the `--out` outline replaced no `rg '^#'` look-back,
because none was made. Both are dropped. Kept: `save.lineChars` (no line of an `--out` file longer than 2000 characters), which
closes the one-line dump that cost a 1 MB answer, and `npm run carried` for judging later changes. `src/` 3,594 → 3,631 lines (+37,
from the line bound). Tests 129 → 133, measure exits 0. The dropped commits stay on `claude/less-lifting-2e3681`.

Branch `claude/onboarding-lab-5060e8`: how a model learns the tool, and one document instead of two. Real sizes: the skill was 5,857
characters and `help` 2,477, so a Codex agent's first call (`cat SKILL.md && browser-layer help`) read about 8.4 KB (2,100 tokens),
and carried through ~72 steps that is ~150k token-reads a run. In Claude Code only the skill's description is always loaded and the body
comes in with one Skill call; `help` is then never read. In 1,102 Codex transcripts 1,101 begin with that two-file read. A command-writing
exam without a browser (`bench/onboarding/`, 32 scenarios, headless `claude -p`; only Claude models were reachable, other families are
unknown) scored, per haiku (3 repeats) / sonnet (2): both files 0.95 / 0.98; skill alone 0.76 / 0.74 (misses `get --sort/--limit`, `dialog`,
`do`, `uncheck`, `menu`); `help` alone 0.88 / 0.88 (misses the rules: pop-ups in one call, suggestion lists, `allow images`, `open --out` for many
pages); nothing 0.21 (invents `search`, `--filter`, `requests`). Invented commands: none with any document, 11 without. A 2 KB judgment-only skill
plus `help` scored 0.92 / 0.95, and the manual as one 4.9 KB document (Start here, commands, Rules) 0.94 to 1.00; the exam wording was tuned once
(the `menu` line), so read these as comparisons. Real runs (haiku, the 7 harness tasks, 3 repeats, $0.1 per arm): a stub skill that says "run
help" costs a step (5.6 steps against 4.3, input tokens +27%, within noise at 7 tasks) and was dropped; the skill body being the manual gave
score 1.00 against 0.95, steps 4.1 against 4.3, input tokens equal, 6 s less wall time. Kept: `SKILL.md` body is the manual, `help` prints the same
text, and `test/onboarding.test.ts` fails if they differ; the loop, rules and the commands the exam found missing moved into it once, the skill's
duplicate prose is gone. Onboarding 8.4 KB → 6.0 KB in one read (frontmatter 1.1 KB of it, which a skill needs), `src/` 3,631 → 3,659 lines (help text,
not logic). Hosts that run `cat SKILL.md && browser-layer help` now read the manual twice: use one of them.
