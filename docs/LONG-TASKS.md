# browser-layer — long tasks

Goes with [DESIGN.md](DESIGN.md) and [PLAN.md](PLAN.md). Written 12 Nov 2026 on `agent-fixes` (0282e00). Nothing here is built.

This is not a list of fixes for tasks that went badly. It is a cost model, a way to measure the tool without a model, and
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
| A3 Research | One fact from each of 20 pages on 5 sites; two are slow, one is a 404, one refuses | pages |
| A4 Transact | A 12-step form: dependent dropdowns, a date picker, two validation errors to correct | interactions |
| A5 Reduce | Three questions over 500 collected records: a filter, a top-10, a count per group | records |
| A6 Endure | 600 calls in one session, the same 20-call loop repeated | calls |
| A7 Recover | A1 and A2 again with a fault in the middle: the browser dies, a tab crashes, the agent "forgets" (starts from a blank context) | faults |

Expected floors today, from reading the code (to be replaced by measured numbers in phase 0):
A1 is 2 calls where a standard marks "next", and one call per page where the control is not in the English word list
(`MORE` in `src/daemon.ts`). A2 needs a shell to turn a records file into addresses; tool-only it is one call per record.
A5 is impossible tool-only: nothing reads a saved file back. A7 loses everything collected before the fault.

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
*Done when.* A1 is 2 calls on all five variants and A2 is 2 calls, both tool-only; calls stay the same at 50 and 500 records.

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
*Done when.* A5 is 3 calls tool-only and every answer in it is under `answer.headChars`; A1 to A3 tool-only never need a
program outside the tool.
*Known risk.* `find --in` was built once and agents with a shell did not use it. That run measured adoption, not need:
the tool-only floor measures need. Adoption is measured after, as gap to floor.

### C3. A record means the same thing in every row, and says what it is (L1, L2)
*Rule.* A saved record file is usable without looking at the page again: a column holds one field in every row, has a
name when the page gives one, and holds no page-only marks.
*State today.* Lists come out as `c1…cN` with no names; one optional part per card makes a column (12 records, 37
columns in the last run); cells carry refs (`[4670] link "…"`), which mean nothing once the page is gone.
*Build.*
1. Names from standards only: table headers (done), `<dt>` for its `<dd>`, `aria-label`/`aria-labelledby` of a field,
   `itemprop` (microdata), and schema.org JSON-LD properties whose value is the cell's text. No name is invented.
2. A saved file holds text and, with `--urls`, addresses. Refs stay in answers about the live page.
3. Column stability (PLAN "Open" item 4). The rule is not known yet. Phase 0 measures it on the corpus and the floor
   site: columns per record field and share of blank cells. Candidate rules are tried against that number; none is
   adopted on one site's evidence.
*Done when.* On the corpus and floor lists: blank cells under 15% (Amazon is 52% today), and A5's questions are
answered by column name where the page has names.

### C4. Work is never lost, and "complete" is only said when shown (L3)
*Rule.* A call that covers many pages writes as it goes. If it stops (an error, a bound, the browser gone) it answers with
what it has, where it stopped and why, and the same call run again carries on from there. It says a list ended only
when the page shows it: the last page has no next link, or the current page is the pager's last. Otherwise it says what it
tried and that the end is not shown.
*State today.* `get --all` keeps its rows in memory and throws them away on any error (three calls of 12 to 17 s each
ended in `error: … not on the page any more` with nothing saved). It answers `end of list` when scrolling brought nothing,
which is not the same as an end; one task fetched the same list four times and got 40, 40, 70 and 40 records.
*Build.* `get --all`, `each` and bulk `open` append to `--out` per page; the answer has three endings: `ended` (shown
how), `not shown to be complete` (what was tried), `stopped` (where, why, and that the same call continues). Re-running
skips what the file already has. The manual's rule "a list is complete only when you can show it ended" becomes
something the tool states.
*Done when.* A7: with a fault at any point, the finished file equals the fault-free one and the extra cost is at most 2
calls. A1 on the re-rendering variant completes.

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
*Done when.* A3 is one call per page that reads; A4 has no call whose only purpose is to look after an error; no answer
in any floor script exceeds its budget. `npm run measure` map sizes do not grow by more than 10%.

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

### C7. Call 600 costs what call 6 costs, and a session survives (L3)
*Rule.* Time per call, memory and what an answer carries do not grow with the length of the session. A browser that
dies, or an agent that lost its context, costs one call to be back where it was.
*State today.* Nothing tests a long session. Tabs pile up (31 opened in one task) with no bound. When the browser goes away the
next command starts a fresh one with no tabs. An agent whose context was compacted has no way to ask where it is.
*Build.*
1. A6 as a test with budgets: p95 time of the last 60 calls within 20% of the first 60; daemon memory flat after call 100.
   Whatever it shows is fixed at its cause.
2. The session's tabs (address, which is current) are kept on disk; a new daemon reopens them, as `show`/`hide` already do.
3. `status`: the session's tabs, the files it saved with their sizes and endings (C4), and the last few calls with how
   each ended. One call puts an agent with a blank context back in the task.
4. A bound on tabs per session from what A6 measures, closing the least recently used; its address stays in `status`.
*Done when.* A6 holds its budgets; A7's "browser dies" and "agent forgets" each cost at most 2 calls.

## 4. Order, and how to run it

Each item is one session in its own worktree from `agent-fixes`, test first, small commits, no merge by the session.

| Phase | Sessions (parallel within a phase) | Touches | Leaves |
|---|---|---|---|
| 0 | `floor`: the site, checkers, par scripts for A1 to A5, both modes · `endure`: A6 and A7 harness | `bench/floor/` only | The floor table in this file: today's numbers for every task |
| 1 | `resume` (C4) · `readback` (C2) · `one-view` (C5) | `daemon.ts` collect code · `data.ts`, `cli.ts` · `daemon.ts` view code | Floors after each |
| 2 | `join` (C1) · `columns` (C3) | collect code · `reader.ts`, `data.ts` | Floors after each |
| 3 | `ledger` (C6) · `survive` (C7) | view code · `daemon.ts` start-up, `client.ts` | Floors after each |
| 4 | Local agent gate on Haiku (short, long, and the floor tasks as prompts), then one paid run if the gate is clean | none | Gap to floor per task; RESULTS |

Before phase 1, the collect code (`recordsAll`, `each`, the bulk writers) moves out of `daemon.ts` (1,483 lines) into
`src/collect.ts` with no behaviour change, so `resume`, `join` and `one-view` do not edit the same lines.

A phase is merged when: its floors dropped as its contract says, no other floor rose, `npm test` and `npm run measure`
are green, and the size note is written. A contract whose floor does not move is reverted, not kept.

## 5. What this plan does not claim

- The floors above marked "expected" are read from code, not measured. Phase 0 measures them; if a floor is already
  better than stated, its contract is dropped.
- Lower floors do not prove agents will take the shorter path. Phase 4 measures that. Earlier work (`find --in`, the
  `--out` outline) lowered a floor and went unused.
- C3's column rule is unknown. It may turn out that no general rule holds, and then the contract is cut to names and
  no refs.
- Sites that refuse the browser decided 13 of the last 35 tasks for both tools. Nothing here changes that.
- Data that comes only from a site's API in pages (one task made 22 `eval` calls) is not covered; `open <url…> --out`
  handles plain GET addresses only.
