# browser-layer — long tasks

Goes with [DESIGN.md](DESIGN.md) and [PLAN.md](PLAN.md). Written 12 Nov 2026 on `agent-fixes`; floors measured 13 Nov (aaec2a3).

Phase 0 (the measure) is built and run; the contracts are not. This is not a list of fixes for tasks that went badly. It is a cost model, a way to measure the tool without a model, and
seven contracts the tool must hold on any long task. Each contract comes from the model or from a standard, has a test that
fails today, and has a number that says when it is done.

## 1. Why a long task costs what it does

Every call re-reads the whole conversation. With `P` the fixed prompt, `c_j` the text of call `j` and `a_j` its answer:

```
tokens(task) = N·P + Σ_j (c_j + a_j)·(N − j)        time(task) ≈ N · (one model turn) + tool time
```

So cost grows with the square of the number of calls, and a character answered early is paid for on every later call.
Measured on 85 recorded tasks: a model turn is about 6 s, the tool is 27% of wall time, and one 174-call task cost 15M
input tokens against 0.66M for the median task. A tool has exactly three levers:

- **L1, calls.** How many calls the task needs (`N`).
- **L2, carried text.** How big each answer is, and how early it comes.
- **L3, lost work.** A failure late in a task throws away what was paid for before it; an error answer is a call that bought nothing.

Anything that does not move one of these three does not make long tasks cheaper. Out of the tool's reach: the agent's own
context handling, sites that refuse the browser, and a model that wanders.

## 2. The measure: a cost floor, with no model and no money

Until now every decision was judged by agent runs: noisy (the same build against itself differs by 20% in steps), paid,
and unable to tell the tool from the model. Long tasks get a measure of the tool alone.

**`bench/floor`** (new): a local, generated site and one checker per task. For each task a *par script* is written by
hand: the best command sequence the tool allows. The harness runs it and reports calls, answer characters, carried cost
(the formula above with `P` = the manual), wall time, and whether the result is complete and correct. That is the floor:
what a perfect agent pays. A change is good when a floor drops and none rises. Agent runs then measure only the *gap to
the floor*; a gap is the manual's problem, not the tool's.

Each task is run twice: **with a shell** (the agent may use `rg`, `jq`, `awk`) and **tool-only** (an MCP or API agent has
only `browser-layer` commands). Where the tool-only script cannot finish the task, the floor is "impossible", and that is a
finding.

| | Task (the general shape, not a site) | What grows |
|---|---|---|
| A1 Collect | 500 records over 25 pages. Five variants of "more": `rel=next` link, numbered pager, a button in a language other than English, infinite scroll, a list that re-renders while paging | pages |
| A2 Enrich | For 60 records of a list, three fields from each record's own page | records |
| A3 Research | One fact from each of 20 pages in a chain: the way to the next page is a link whose name only this page gives; two pages are slow | pages |
| A4 Transact | A 12-step form: dependent dropdowns, a date picker, two validation errors to correct | interactions |
| A5 Reduce | Three questions over 500 collected records: a filter, a top-10, a count per group | records |
| A6 Endure | 600 calls in one session, the same 20-call loop repeated | calls |
| A7 Recover | A1 again with the browser killed six seconds in. A crashed tab is not built yet | faults |
| A8 Forgets | Three tabs open and a file saved, then the agent's context is lost: the calls and characters to learn the tabs' addresses and the file's path, with `status` and with `tabs` and `map` | calls |
| A9 Browser dies | The browser is killed with three tabs open; one fact is needed from each | faults |

A third mode, **plain**, was added after the first run: the one command the manual names for the job and nothing an
expert would add. A `plain` row that fails is the tool giving a wrong or no result to an agent that did what it was told.

### Measured floors, 13 Nov 2026 (`npm run floor`, `bench/results/floor.json`)

| Task | Mode | Result | Calls | Characters answered | Read over the task |
|---|---|---|---|---|---|
| A1 collect, `rel=next` | tool / plain | done / done | 2 / 2 | 2,060 | 19k |
| A1 collect, infinite scroll | tool / plain | done / done | 2 / 2 | 2,000 | 19k |
| A1 collect, numbered pager | tool / plain | done / **wrong** | 3 / 2 | 2,173 | 27k |
| A1 collect, button not in English | tool / plain | done / **wrong** | 2 / 2 | 4,041 | 22k |
| A1 collect, list that re-renders | tool / plain | done / **failed** | 2 / 2 | 4,693 | 25k |
| A1 collect, slow server (400 ms a page) | tool / plain | done / **failed** | 5 / 2 | 2,213 | 40k |
| A2 enrich 60 | tool / shell | done / done | 4 / 3 | 8,288 / 3,369 | 47k / 29k |
| A3 research 20 | tool | done | 20 | 6,356 | 203k |
| A4 transact 12 steps | tool | done | 16 | 5,677 | 153k |
| A5 reduce 500 | tool / shell | done / done | 4 / 3 | 24,130 / 2,560 | 77k / 28k |
| A7 browser dies while collecting | tool | done | 4 (2 without the fault) | 2,579 | 33k |

A6 (`npm run floor -- --endure`, `bench/results/endure.json`): 600 calls closing tabs each round: time per call p50 489 →
473 ms, p95 657 → 654 ms, browser 486 → 502 MB, daemon 135 → 154 MB, no errors. 200 calls never closing a tab (40 tabs):
time per call unchanged (p50 478 → 488 ms), browser 1,929 → 5,097 MB in 18 → 46 processes, answers 25,617 → 39,959
characters per 60 calls (`tabs` lists them all).

### What the floors say

1. **A perfect agent already pays little.** Every list shape is 2 to 5 calls, by sequences only an expert would write:
   24 clicks typed into one `steps`, 25 `get`/`click` pairs in one `steps`, or reading 25 pages by guessed addresses.
   The tool can do long tasks in few calls. That part of the problem is not capability.
2. **The plain command is right on 2 of 6 list shapes.** `get --all` answers `ended: end of list` with 20 of 500 records
   on a numbered pager and on a button not named in English: an agent that trusts it delivers 4% of the list and says
   it is complete. On a list of more than about 25 pages, or a slower server, it fails at `read.timeoutMs` (`get` counts
   as a read: 20 s) with nothing saved, and the call that timed out goes on turning pages in the tab: reads made after
   it lost a page (480 of 500 records) until the tab was closed.
3. **One file's columns differ between pages.** In `get --all` an optional part (a Sale mark) puts the price in column 4
   on pages whose first row has no mark and column 5 on the others. `--sort` on the price is wrong, and so is any
   program that reads the file by column.
4. **Without a shell the same job costs 2.7 times as much to read** (A5: 77k against 28k) and leaves the arithmetic over
   500 rows to the model, because nothing reads a saved file back. A2 is 47k against 29k.
5. **The tasks that are one call per page or per step are where the floor is high** (A3 203k, A4 153k, against 19k to
   47k for the rest), though no answer in them is over 500 characters. That is the square law; and 57 to 62% of what is
   read in them is the manual (5,591 characters) read again on every call. With a prompt cache a re-read character
   costs about a tenth of a new one, so this weighs less in money than in this count.
6. **A name shared by two kinds of control costs a call.** `check Terms` failed because a link is also named Terms; a
   link cannot be checked.
7. **A browser that dies costs two extra calls and all the work again** (16 s of paging redone). Nothing is kept.
8. **Session length alone costs nothing.** 600 calls are flat in time and memory. Tabs left open are what grows: about
   110 MB a tab (summed process memory, which counts shared pages more than once) and a longer `tabs` answer.

### After C4 for `get --all` (13 Nov)

| Row | Before | After |
|---|---|---|
| A1 plain, `rel=next` and scroll | done | done |
| A1 plain, numbered pager | wrong: 20 of 500, "end of list" | 20 of 500, says `not shown to be complete` |
| A1 plain, button not in English | wrong: 20 of 500, "end of list" | 20 of 500, says `not shown to be complete` |
| A1 plain, list that re-renders | failed at 20 s, nothing saved | done |
| A1 plain, slow server | failed at 20 s, nothing saved | done |
| A1 tool, slow server | 5 calls, 40k read | 2 calls, 20k read |
| A7 browser dies while collecting | 4 calls, 22 s, every page again | 4 calls, 18 s, carries on from the page reached |

No other row moved, beyond 1k more read per task from two more lines in the manual. `npm run measure` unchanged; tests 145 → 148.
The two rows that say so become `done` with C1 (continuation by `aria-current`, and a control the agent names).

### After C4 for `each` and bulk `open` (13 Nov)

A7 over many pages (`A7 recover: browser dies during each`: the browser killed 3 s into `each 'read'` over the 60 item
pages, 400 ms each; the agent runs the same command again when the answer is not 60 pages read):

| | Before | After |
|---|---|---|
| Calls | 2 | 2 |
| Seconds | 10 | 8 |
| Pages fetched twice | 26 | 10 |
| Characters answered | 1,460 | 2,098 |

The 10 that are fetched twice are the pages in flight when the browser died (`each.concurrency`); every page read before
is kept. The answer is longer by the list of the pages' headlines and the line that says the same command carries on.
Killing a bulk `open --out` part way leaves the pages that had arrived, and the same command fetches only the rest
(tests, `test/cli.test.ts`). Times vary by a second or two between runs.

After C2 for records and columns that line up (13 Nov): A5 tool-only 77k → 29k read. The manual grew from 5,591 to
5,789 characters for the new `get` lines, which every call re-reads: A3 203k → 206k, A4 153k → 156k. That is the price
of any new verb, and it is paid most by the tasks that already cost most. Tests 148 → 153, `npm run measure` unchanged.

### After C7 (13 Nov)

Floors before (`e10de00`, run again with these tasks) and after:

| Row | Before | After |
|---|---|---|
| A8 agent forgets: tabs and map | 2 calls, 734 chars, 19k read: the tabs, the page; **the file is not found** (nothing lists files) | same: it is the best a build without `status` can do |
| A8 agent forgets: `status` | not possible | 1 call, 734 chars, 13k read: the tabs and the file |
| A9 browser dies, a fact from each of 3 tabs | 2 calls (`use` fails: no tab 1; open the three again, whose maps hold the facts), 2,411 chars, 21k read | 1 call, 2,633 chars, 15k read |
| A7 browser dies while collecting | 4 calls, 35k read | 4 calls, 36k read (the one new manual line) |
| A6 keeping tabs: browser memory, first → last 60 calls | 1,929 → 5,097 MB in 18 → 46 processes | 1,483 → 1,492 MB in 14 → 14 processes |
| A6 keeping tabs: characters answered per 60 calls | 25,617 → 39,959 | 29,198 → 30,877 |
| A6 keeping tabs: time per call p50 | 478 → 488 ms | 461 → 467 ms |
| A6 closing tabs: p50 / browser | 489 → 473 ms, 486 → 502 MB | 478 → 458 ms, 483 → 498 MB |

The manual grew from 6,042 to 6,163 characters (the `status` line, which every call re-reads): A3 212k → 215k, A4 148k →
150k, A5 30k → 31k read, and no other row moved. Tests 157 → 161; `npm run measure` unchanged and exits 0. A9 and A7 are not the
same fault: A7's agent must still open the list again to get a ref (a restart gives new refs), so it stays 4 calls.
Memory with tabs left open is bounded by `tabs.max`: 40 tabs opened, 8 kept (the browser holds 14 processes, 1.5 GB: the
8 tabs, the daemon's own pages and the browser's fixed processes).

What this changes below: C1's number is the `plain` rows, not the call count; C5 and C6 cannot be shown by a floor (a
perfect agent never reads twice or looks after an error it did not make) and are judged on recorded runs and in phase 4;
C7 loses its worry about session length and keeps the tab bound and the restore (built, see below).

## 3. The contracts

### C1. A loop runs in the tool, not in the conversation (L1)
*Rule.* When every round of a repetition is the same operation, it is one call. The number of calls does not grow with the
number of pages or records.
*State today.* `get --all` follows a list's own continuation; `each` runs one read over addresses given on the command
line. Missing: the join between them, and continuation that does not depend on English.
*Build.*
1. `each` takes its addresses from records: `each '<read>' --from <ref|file> [--col cN]` (the links of a list on the
   page, or a column of a saved file). Same verb, new source. This is A2 in two calls, with or without a shell.
2. Continuation by standards, in this order: `rel=next` (HTML link types); the link after `aria-current="page"` inside a
   navigation landmark (WAI-ARIA); scrolling, for a list with neither. Where none exists the answer names the candidate
   controls and the agent says which: `get <ref> --all --more <ref|name>`. The English word list is then deleted
   (CLAUDE.md rule 4: it is a locale case).
*Done when.* Every `plain` A1 row is done (2 of 6 today), or says in its answer that the end is not shown and what to
name; A2 tool-only is 2 calls and under 30k read (4 and 47k today).
*Built, 13 Nov:* the next page by `aria-current` in a navigation landmark, after `rel=next`; `--more <ref|name>`;
`each --from <ref|file>`. Plain A1 rows: 5 of 6 done, and the sixth (a button in German) says the end is not shown
and how to name the control; with `--more` it is 2 calls and 2,028 characters (24 typed clicks and 4,012 before).
A2 tool-only: 4 calls, 48k read → 3 calls, 31k (2 is not reachable: open, collect, visit). 157 tests green.
*Kept, against this plan:* the English word list. Without it a list with a plain "Next" or "Load more" button, which
is most of them, would need a second call to name the control. It is now the third thing tried, after the two
standards. Deleting it is a decision about purity against one call on most lists, and is the user's.

### C2. What the tool saves, the tool reads back (L1, L2)
*Rule.* Every file the tool writes (`--out`, a result over `answer.maxChars`) can be queried by the tool with the verbs
records already have. No answer tells the agent to use a program the agent may not have.
*Why it is general.* The file design assumes a shell. An MCP or API agent cannot open a file at all, so today a long
result is unreachable for it. For an agent with a shell, its own `sed`, `rg` and `cat` are unbounded: 14% of calls and 27%
of all answer text in the last run, 42 answers over 8,000 characters.
*Build.* `get` takes a file where it takes a ref, through the same `query()` (`src/data.ts`): `--cols`, `--sort`,
`--limit` as now, plus `--where <col><op><value>` (`=`, `~` contains, `<`, `>`, compared as `--sort` compares),
`--count`, and `--group <col>` (a count per value). `find <text> --in <file>` for text files. Answers that name a saved
file name these, not `rg` and `sed`.
*Done when.* A5 tool-only reads no more than with a shell (77k against 28k today) and its biggest answer is under
`answer.headChars` (11,730 characters today); no floor script needs a program outside the tool.
*Done for records, 13 Nov:* `get <file>` with `--where`, `--count`, `--group`, on a file or a list, and inside `steps`.
A5 tool-only: 4 calls, 24,130 characters answered, 77k read → 3 calls, 3,134, 29k (with a shell: 29k); biggest answer
1,647. Not done: text files. An answer over `answer.maxChars`, and a bulk `--out` file, still name `rg` and `sed`, which
an agent without a shell does not have; no floor row needs one yet, so `find --in` waits for a row that does.
*Known risk.* `find --in` was built once and agents with a shell did not use it. That run measured adoption, not need:
the tool-only floor measures need. Adoption is measured after, as gap to floor.

### C3. A record means the same thing in every row, and says what it is (L1, L2)
*Rule.* A saved record file is usable without looking at the page again: a column holds one field in every row, has a
name when the page gives one, and holds no page-only marks.
*State today.* The columns of one `get --all` file differ between its pages (finding 3). Lists come out as `c1…cN` with no names; one optional part per card makes a column (12 records, 37
columns in the last run); cells carry refs (`[4670] link "…"`), which mean nothing once the page is gone.
*Build.*
1. Names from standards only: table headers (done), `<dt>` for its `<dd>`, `aria-label`/`aria-labelledby` of a field,
   `itemprop` (microdata), and schema.org JSON-LD properties whose value is the cell's text. No name is invented.
2. A saved file holds text and, with `--urls`, addresses. Refs stay in answers about the live page.
3. Column stability (PLAN "Open" item 4). The rule is not known yet. Phase 0 measures it on the corpus and the floor
   site: columns per record field and share of blank cells. Candidate rules are tried against that number; none is
   adopted on one site's evidence.
*Done, 13 Nov, for columns across pages:* a field is the same column on every page of one `get --all`; A5's scripts
lost their workaround.
*Done, 13 Nov, for refs and names:* a file written with `--out` holds text and, with `--urls`, addresses (`Volvo V50 →
https://…`, not `[4670] link "Volvo V50"`); answers to the agent keep refs. A list's columns take names from the
standards above, only when every row that has the field gives the same name (a rating's "4.5 out of 5 stars" differs
per row and is content). A `<dt>` is the identity of its `<dd>`'s column and no cell of its own. `get --all` keeps each
name with its field (names had been taken by page position, which a page with a new part first put on the wrong
column). Tests 157 → 162. Floor (`npm run floor`): every row done as before, same calls; A5 tool 3,120 → 3,031 characters
answered, 30,419 → 30,370 read (its script reads names from plain cells); the first answer of the other `get --all` rows
moves by +40 or −26 characters (rows without refs are shorter, so a different number of them fills `answer.headChars`),
read +0.2% at most. The manual did not change. A floor list still shows the pages-differ cause of finding 3 in a small
form: when one page has a single row with the Sale badge, its class is dropped from the path (a class only one row has is
that row's identity), so those three of 500 rows put it in a sixth column. Nothing in this change moved it.
*Not done: the blank-cell rule. Measured, and no general rule holds.* `npm run measure` now prints, for each corpus
list of 3 rows and 3 columns or more, rows x columns, the share of blank cells, and the same for the columns that at
least half the rows fill (the template):

| List | Rows x columns | Blank | Template columns | Blank in them |
|---|---|---|---|---|
| Amazon, product cards | 16 x 22 | 52% | 11 | 11% |
| Amazon, filter sidebar | 46 x 14 | 63% | 5 | 18% |
| Google Flights | 57 x 17 | 30% | 11 | 3% |
| GitHub, sidebar (releases, contributors, languages) | 4 x 20 | 56% | 12 | 44% |
| Hacker News (a table) | 92 x 3 | 57% | 1 | 35% |
| Floor site, 20 cards | 20 x 5 | 15 to 16% | 5 | 15 to 16% |

Where the blanks come from: not from the columns a template has (Amazon's cards are 11% blank in the 11 columns most
cards fill, Flights 3%) but from rows that are not records of the template: three Amazon rows are carousels and
promotions whose fields each make a column (eleven columns filled in one or two rows), Flights has two such rows, and
GitHub's sidebar has a row with fourteen contributor links (`a`, `a#2` … `a#14`). Hacker News alternates a story row and a
details row, which is the page's own table. The floor site's blanks are one honest absence: an optional Sale badge that one card in five has,
which no column rule can fill.
Rules tried on the records of every corpus list and the floor (as saved-file cells, which come out a column narrower
than the printed ones: Amazon's cards are 54% there), by simulation on the dumped records and, for the first, in the code: (1) a class counts as part of a field's path only when at least a quarter, half, three quarters of the rows
carry it (now: more than one row): Flights 30% → 26, 21, 21%, nothing else moves; (2) a path used twice in a row is one
multi-valued field: GitHub 20 → 7 columns, but the blank share rises on Flights and the sidebar (fewer cells, the same blanks) and
two fields of one row that share a path (a subtitle and a line, both `div.line`) become one cell; (3) a field only one
row has goes to one catch-all column: Amazon cards 54% → 24%, but two different one-row badges become one column
and which badge it was is lost, and the decision depends on the rows of one page, so the pages of one `get --all` could
fold the same field differently; (4) one column for fields with the same tag path and different classes that never
share a row: Flights 30% → 21% (price and lowest price, two emission labels join, which is right), Amazon 54% → 50%,
but a title row and a price row of a mixed list would join, and it too depends on one page's rows. None brings the
corpus under 15%, none changes the floor (16% is the Sale badge), and (3) and (4) lose which field a value was or
differ between pages. The rule is not a column rule: it is which rows are records of the list at all, and a structural
way to say so (rows sharing less than half the template's fields are another kind of row) is not tried here. The code
is left as it was.
*Done when.* A5's `--sort` on the price column is right with no workaround in the script (done); on the corpus and floor
lists blank cells are under 15%: **not met**, Amazon is 52% and Flights 30% today, for the reason above.

### C4. Work is never lost, and "complete" is only said when shown (L3)
*Rule.* A call that covers many pages writes as it goes. If it stops (an error, a bound, the browser gone) it answers with
what it has, where it stopped and why, and the same call run again carries on from there. It says a list ended only
when the page shows it: the last page has no next link, or the current page is the pager's last. Otherwise it says what it
tried and that the end is not shown.
*State today.* `get --all` keeps its rows in memory and throws them away on any error (three calls of 12 to 17 s each
ended in `error: … not on the page any more` with nothing saved). It answers `end of list` when scrolling brought nothing,
which is not the same as an end; one task fetched the same list four times and got 40, 40, 70 and 40 records.
*Build.* A call that collects is not a read: its limit is per page, not 20 s for the whole list, and a call that
stopped does not go on acting in the tab. `get --all`, `each` and bulk `open` append to `--out` per page; the answer has three endings: `ended` (shown
how), `not shown to be complete` (what was tried), `stopped` (where, why, and that the same call continues). Re-running
skips what the file already has. The manual's rule "a list is complete only when you can show it ended" becomes
something the tool states.
*Done when.* A7 repeats no page already saved; the slow-server and re-rendering `plain` rows are done; no `plain` row
says a list ended when it did not.
*Done for `get --all`, 13 Nov* (floors below). A7 stays at 4 calls: the fourth is opening the page again after the browser
died (C7 restores the tab, but a restart gives its list new refs, so it is still read again).
*Done for `each --out` and bulk `open --out`, 13 Nov.* The file is written as each page finishes (`bulkRun` in
`render.ts`), and beside it, while any page is failed or missing, `<file>.unfinished` holds the command and its
addresses in order. The same command run again (same read, same addresses, so `--from` too, whose addresses are those
of the records) keeps every page the file holds as read, fetches the rest, ends with the pages in the order of the
addresses and removes the marker; the answer says `N kept from the file`. A page that failed is fetched again, so a
permanent 404 keeps the marker and the answer says that the same command fetches only the failed. Any other command
(or a file with no marker) replaces the file as before. A kept page's headline has no title: the file does not hold one.

### C5. An answer carries the next decision, inside one budget (L1, L2)
*Rule.* No answer makes the agent call again for something that answer had room for; and no answer is bigger than its
budget. One rule decides every view. An error is an answer too: it carries what changed.
*State today.* Five rules and five sizes decide a view (map on open; text or map when an action replaces the page;
`open.dialogChars`; `answer.fileChars`; `answer.previewChars`). Opening a page always answers with a map, and after 40%
of opens the next call read that same page (median 2,600 characters, 79% under 4,000). A failed single command answers
with one line and no page, so the agent looks again; 9% of calls are errors. `--out` previews cut at a line, so one wide
row makes an 8,000 to 10,000 character "preview".
*Build.*
1. One view rule, used by open, go, back, an action that changes the document, and a dialog: the text when it fits the
   budget, else the map with the text of the main landmark as far as the budget allows. It replaces the five; the policy
   keys it makes unused are deleted.
2. Every failed action answers as `steps` already does on a failure: the error, then the page as it is now (changed lines).
3. A preview is cut to its budget in characters, wide rows included.
*Done when.* A4 is 15 calls (16 today: finding 6); no answer in any floor script exceeds its budget; `npm run measure`
map sizes do not grow by more than 10%. The view rule cannot be shown by a floor (A3 is already one call a page for a
perfect agent): it is kept only if agent runs in phase 4 show fewer calls per page opened.
*Built, 13 Nov, three parts, each with a test that failed first:*
1. A page arrives with its main landmark as text when that is no longer than `answer.headChars` (4,000), each list of
   records in it as its one line; a map the agent asks for is still the map, and what was given is not sent again by a
   `read`. Measured by a new `plain` row for A3 (open each page; read only where the answer lacks the fact): 40 calls,
   1,009k read → 20 calls, 493k. On the corpus four first answers are unchanged and Google Flights grows from 1,805 to
   2,443 characters (+35%, over the 10% set above): it now carries "61 results returned", "Cheapest from ₹6,475" and
   the refs of the sort and tab controls, which the map had only as "actions: 9". Kept for phase 4 to judge.
   A first version gave lists whole and raised every list-page row by 2k to 7k; with lists as one line no row rose.
2. A failed action answers with the lines that changed since the agent's last view, when any did.
3. A name two controls share means the one the command can act on. A4: 16 calls, 156k → 15 calls, 145k.
*Not built:* one rule in place of the five. Nothing measured asks for it, and the dialog and long-read rules have their
own evidence (DESIGN §9). The `--out` preview was not a defect: it is already cut at `answer.previewChars`; the
8,000-character answers in the recorded run were several commands chained with `&&`.

### C6. Each thing is shown once, and the tool keeps the account (L2)
*Rule.* DESIGN §1a already says it. It must hold for every kind of answer, not only the ones that remember.
*State today.* Three separate memories (`tab.shown`, `tab.read`, `tab.seen`), and `read <ref>`, `read --page` and
`read --full` use none of them. 85% of reads are `--full`; a quarter of all characters read had been shown before in the
same task.
*Build.* One ledger per tab: the lines the agent has been shown for the current document. Every answer (map, read,
`read <ref>`, find, an action's changes) is written against it: a line already shown and unchanged is not sent again;
a run of them is one line saying how many. `--full` stays as the explicit way to see all of it. The three memories are
removed in the same change.
*Done when.* Replaying the recorded reads through the new code, repeated characters fall from 25% to under 5%; then the
local agent gate shows no more look-back calls than before (a ledger that hides what the agent needs shows up there).

### C7. Call 600 costs what call 6 costs, and a session survives (L3) ✅
*Rule.* Time per call, memory and what an answer carries do not grow with the length of the session. A browser that
dies, or an agent that lost its context, costs one call to be back where it was.
*State before.* Nothing tested a long session. Tabs piled up (31 opened in one task) with no bound. When the browser
went away the next command started a fresh one with no tabs. An agent whose context was compacted had no way to ask
where it was.
*Built (13 Nov, `survive`).*
1. A6 stays as the check (session length is flat: finding 8).
2. After every command each session's tabs (id, address, last use, which is current) are written to `<home>/kept.json`;
   a new daemon reopens them with the same ids before it answers. `stop` deletes the file; attached to a person's Chrome
   nothing is written or restored (DESIGN §10).
3. `status`: the session's tabs, the addresses of tabs let go, the files saved with `--out` (an unfinished `get --all`
   says so: `<file>.unfinished`) and the last `status.calls` (5) calls with the first line of each answer. The files are a
   log, `<home>/saved.log`, that the daemon and the CLI's plain `open --out` both append to, so a restart loses none.
4. `tabs.max` (8): after a command the session's least recently used tabs past it close, never the current one; the
   answer names them and `status` keeps their addresses, which an idle session's dropped tabs (`sessions.idleMs`) join.
   The number is from A6's 110 MB a tab (DESIGN §9).
*Not built.* A crashed tab (the renderer dies, the browser lives). Page state: a half-filled form or scroll position does
not come back, only the address. A `status` for plain `open` calls (they never reach the daemon, so their answers are not
in the last calls; their `--out` files are listed).

## 4. Order, and how to run it

Each item is one session in its own worktree from `agent-fixes`, test first, small commits, no merge by the session.

| Phase | Sessions (parallel within a phase) | Touches | Leaves |
|---|---|---|---|
| 0 ✅ | `bench/floor`: the site, checkers, par scripts for A1 to A5 and A7 in three modes, A6 | `bench/floor/` only | The measured table in §2 |
| 1 | `resume` (C4; `get --all` ✅) · `readback` (C2; records ✅) · `one-view` (C5 ✅, to be judged in phase 4) | `daemon.ts` collect code · `data.ts`, `cli.ts` · `daemon.ts` view code | Floors after each |
| 2 | `join` (C1 ✅) · `columns` (C3; across pages ✅) | collect code · `reader.ts`, `data.ts` | Floors after each |
| 3 | `ledger` (C6) · `survive` (C7 ✅) | view code · `daemon.ts` start-up, `client.ts` | Floors after each |
| 4 | Local agent gate on Haiku (short, long, and the floor tasks as prompts), then one paid run if the gate is clean | none | Gap to floor per task; RESULTS |

If two sessions are to edit the collect code at once, it first moves out of `daemon.ts` into `src/collect.ts` with no
behaviour change. Phase 1 has run one item at a time so far, so the move has not been made.

A phase is merged when: its floors dropped as its contract says, no other floor rose, `npm test` and `npm run measure`
are green, and the size note is written. A contract whose floor does not move is reverted, not kept.

## 5. What this plan does not claim

- The floors are measured on one generated site. It has no ads, no overlays and no slow scripts; real pages cost more
  than these numbers, never less.
- The par scripts are the best sequences found by hand, not proven to be the best there are.
- Lower floors do not prove agents will take the shorter path. Phase 4 measures that. Earlier work (`find --in`, the
  `--out` outline) lowered a floor and went unused.
- C3's column rule is unknown. It may turn out that no general rule holds, and then the contract is cut to names and
  no refs.
- Sites that refuse the browser decided 13 of the last 35 tasks for both tools. Nothing here changes that.
- Data that comes only from a site's API in pages (one task made 22 `eval` calls) is not covered; `open <url…> --out`
  handles plain GET addresses only.
