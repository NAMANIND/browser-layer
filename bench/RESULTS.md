# Benchmarks — 31 Oct 2026

Installed Chrome, headless, 1280×900, from India. Five live sites. Raw data in `results/`.

## 1. Can we cut CSS? (`css-modes.mjs`, median of 2 runs)

Modes: **full** (everything) · **meaning** (no images, fonts, media; animations off; stylesheets kept) ·
**nocss** (meaning + stylesheets blocked, `<style>` removed, `style` attributes stripped).

| Site | Load ms full / meaning / nocss | MB full / meaning / nocss | Controls vs full: meaning | Controls vs full: nocss |
|---|---|---|---|---|
| Hacker News | 1857 / 1887 / 2122 | 0.01 / 0.01 / 0.01 | identical | identical |
| GitHub repo | 2955 / 2586 / 2489 | 2.40 / 2.05 / 1.73 | identical | 11 lost, **65 hidden ones surfaced** (mobile nav, collapsed menus) |
| Google Flights | 2699 / 2878 / 2672 | 1.39 / 1.21 / 1.26 | identical | **42 lost** (the Best / Cheapest tabs among them), 38 hidden dialogs surfaced |
| Amazon search | 9610 / 3485 / 3530 | 2.81 / 1.79 / 1.50 | within noise¹ | 77 hidden ones surfaced |
| React TodoMVC | 2166 / 1457 / 1505 | 0.29 / 0.28 / 0.28 | identical; task works | task works; CSS-generated "❯" lost from a label |

¹ Amazon's own load-to-load variation with full CSS is 36 lost / 33 extra controls (ads and product
rotation). The meaning-mode difference (9 / 10) is inside that.

**Finding.** Cutting decoration (images, fonts, media, motion) keeps the page exactly as the agent
needs it and saves 13–36% of bytes (Amazon loads 2.7× faster). Cutting all CSS breaks real pages:
controls disappear (Flights) and hidden ones appear as if real (GitHub, Amazon). Style time drops by
at most ~90 ms, which does not show up in load time.

## 2. How much of a load is painting? (`paint-cost.mjs`, Chrome trace, one run)

| Site | Script | Style | Layout | Paint (record) | Pixels (raster + composite + decode) | Paint + pixels |
|---|---|---|---|---|---|---|
| Hacker News | 1 | 8 | 6 | 14 | 77 | 91 ms |
| GitHub repo | 216 | 94 | 46 | 68 | 154 | 222 ms |
| Google Flights | 517 | 81 | 46 | 107 | 57 | 164 ms |
| Amazon search | 697 | 84 | 59 | 51 | 77 | 128 ms |
| React TodoMVC | 85 | 2 | 12 | 10 | 59 | 69 ms |

Milliseconds of traced CPU work. Approximate: some slices nest, and raster runs on worker threads in
parallel with the main thread, so it is not all on the critical path.

**Finding.** Painting costs about 70–220 ms of CPU per page load, 13–41% of Chrome's work on real
sites. Page loads take 1.5–3.5 s, almost all of it network and script. Removing paint would cut a
few percent of wall time for one tab, and a real share of CPU when many tabs run at once.

## 3. Agents on real tasks (`agents/run.mjs`, one run per tool per task)

Same agent, model, prompt and task; only the browser tool changes. Runner: cursor-agent headless,
model `claude-sonnet-5-thinking-high`, allowed to run only that tool and read files. Each answer is
checked against ground truth (fixture state, or the Hacker News and GitHub APIs). Six tasks run on
local fixture apps (`agents/site.mjs`), two on live sites. Tools: browser-layer, Vercel agent-browser
0.41.0, Microsoft playwright-cli 0.1.22. Tokens include cache reads.

| Task | browser-layer | agent-browser | playwright-cli |
|---|---|---|---|
| shop | ✅ 128k · 6 steps · 23 s | ✅ 145k · 5 steps · 48 s | ✅ 103k · 4 steps · 30 s |
| flights | ✅ 330k · 15 steps · 52 s | ✅ 921k · 27 steps · 131 s | ✅ 506k · 22 steps · 51 s |
| reports | ✅ 104k · 5 steps · 26 s | ✅ 162k · 6 steps · 36 s | ✅ 385k · 18 steps · 70 s |
| orders | ✅ 388k · 17 steps · 102 s | ✅ 286k · 10 steps · 48 s | ✅ 246k · 9 steps · 46 s |
| signup | ✅ 106k · 5 steps · 17 s | ✅ 163k · 6 steps · 29 s | ✅ 276k · 13 steps · 29 s |
| settings | ✅ 93k · 4 steps · 15 s | ✅ 137k · 5 steps · 28 s | ✅ 151k · 7 steps · 19 s |
| hn | ✅ 54k · 2 steps · 10 s | ✅ 91k · 3 steps · 16 s | ✅ 148k · 6 steps · 35 s |
| github | ✅ 52k · 2 steps · 13 s | ✅ 63k · 2 steps · 12 s | ✅ 92k · 4 steps · 12 s |
| **Total** | **8/8 · 1255k · 56 steps · 258 s** | **8/8 · 1968k · 64 steps · 348 s** | **8/8 · 1909k · 83 steps · 292 s** |

**Finding.** All three tools solve all eight tasks. browser-layer uses 36% fewer tokens than
agent-browser and 34% fewer than playwright-cli, with the fewest steps and least time. It is
cheapest on 6 of 8 tasks. It loses `orders` (pagination): agent-browser clicks "Next" by name in one
command, while browser-layer needs a ref from a fresh map each page, and the agent wasted steps there.

Caveats: one run each, so single-task differences within ~20% are noise; we wrote the fixtures.

### 3a. After fixing what the transcripts showed (browser-layer only, rerun)

Two defects, not agent mistakes: after `click Next` every row of the table changed, so the answer was
the map, which a new page of records leaves unchanged (the agent could not see the click worked and
went looking with `net` and `eval`); and `get` stopped at 20 of 40 records. Now an action whose change
is new records answers with those records (§4.4 of DESIGN), `get` returns what fits one page, and an
action can name its control (`click "Next"`).

| Task | Before | After | agent-browser | playwright-cli |
|---|---|---|---|---|
| orders | 388k · 17 steps | **219k · 10 steps** (one other run: 190k · 9 steps, the model miscounted 3 rows as 4) | 286k · 10 | 246k · 9 |
| shop | 128k · 6 steps | 108k · 5 steps | 145k · 5 | **103k** · 4 |
| flights | 330k · 15 steps | **292k · 14 steps** | 921k · 27 | 506k · 22 |

With the reruns, browser-layer is cheapest on 7 of 8 tasks; shop is within noise of playwright-cli.

## 4. web-agent-bench (a third party's suites, 3 runs each)

[web-agent-bench](https://github.com/nsosio/web-agent-bench) is an independent benchmark that already
drives agent-browser. Its scenarios, prompts, answer checks, per-tool guides and command guard are
used as they are; browser-layer gets a copy of agent-browser's thin driver with only the CLI swapped,
and the guard also blocks browser-layer's bypasses (`eval`, `net`, `cookies`, `storage`, `allow`, the
login window, and the plain-HTTP fast path). The brain is cursor-agent (`claude-sonnet-5-thinking-high`)
instead of their API loop, with the guard run before every shell command as a hook, so a blocked
command gets their message and the agent carries on, as in their loop. Suites: controlled, scroll,
dynamic, hard (auth fails for every tool by design; vision needs pixels, which browser-layer never takes).
Medians of 3 runs; tools alternate order within each run.

| Task | browser-layer | agent-browser 0.41.0 |
|---|---|---|
| controlled/login | 3/3 · 69k · 3 steps · 12 s | 3/3 · 318k · 12 steps · 59 s |
| controlled/shop-filter | 3/3 · 69k · 3 steps · 11 s | 3/3 · 233k · 7 steps · 37 s |
| controlled/todos | 3/3 · 106k · 5 steps · 21 s | 3/3 · 410k · 11 steps · 56 s |
| scroll/scroll-bottom | 3/3 · 68k · 3 steps · 10 s | 3/3 · 240k · 9 steps · 38 s |
| scroll/load-more | 3/3 · 181k · 9 steps · 32 s | 3/3 · 562k · 20 steps · 71 s |
| dynamic/wait-for-value | 3/3 · 68k · 3 steps · 13 s | 3/3 · 181k · 7 steps · 29 s |
| dynamic/poll-status | 3/3 · 86k · 4 steps · 14 s | 3/3 · 292k · 11 steps · 46 s |
| hard/multi-step-form | 3/3 · 182k · 9 steps · 24 s | 3/3 · 479k · 13 steps · 53 s |
| hard/paginated-search | 3/3 · 282k · 13 steps · 47 s | 3/3 · 1042k · 26 steps · 87 s |
| hard/modal-trap | 3/3 · 124k · 6 steps · 24 s | 3/3 · 248k · 9 steps · 35 s |
| **All 30 runs** | **30/30 · 3.7M tokens · 176 steps · 11 min** | **30/30 · 12.8M tokens · 391 steps · 28 min** |

**Finding.** Both pass everything. browser-layer uses 3.4× fewer tokens, 2.2× fewer steps and 2.6× less
time. A step costs about the same with either tool (~22k vs ~29k tokens, ~90% of it the harness's own
prompt re-read each step), so the gap is the number of steps. Part of agent-browser's is its own guide
(reading the skill document, trying to `export` a session the guard blocks); the rest is design:
browser-layer's `tab` answers with the page and every action with what changed, where agent-browser
re-snapshots, waits and reads after each action. Caveats: 3 runs, small fixture sites, and the
cursor-agent harness multiplies step count by a large per-step prompt.

Charts for posts (SVG and 2× PNG) are in `charts/`, and `charts/results.html` is a page with the
charts and side-by-side transcripts; `node bench/charts.mjs` rebuilds all of them from `results/`.


### Again on Claude Code, with Browser Use 1.0 (12 Nov 2026, browser-layer 0.1.4)

The same 10 scenarios and 3 runs each, with Claude Code (`claude -p`, Sonnet) as the brain instead of cursor-agent, and
Browser Use 1.0 CLI (a Python package, `browser-use==1.0.0`) as a third tool. The guard runs as a PreToolUse hook on every
Bash call. browser-layer's `steps` and `each` are checked command by command inside their quotes, so `steps 'eval …'` is
refused. Browser Use's CLI is Python piped on stdin, so it gets a different guard: scripts may use its helpers and `js()` to
read the page's DOM, and may not import, touch files or processes, call `cdp()` or `http_get`, or make network calls from the
page. That is a text filter, not a sandbox. Each Browser Use run had its own headless Chrome. Raw rows (90):
`results/web-agent-bench-claude.jsonl`.

| Task | browser-layer | agent-browser 0.41.0 | Browser Use 1.0 |
|---|---|---|---|
| controlled/login | 3/3 · 147k · 3 steps · 11 s | 3/3 · 197k · 4 · 10 s | 3/3 · 195k · 4 · 13 s |
| controlled/shop-filter | 3/3 · 147k · 3 steps · 9 s | 3/3 · 197k · 4 · 10 s | 3/3 · 154k · 3 · 10 s |
| controlled/todos | 3/3 · 147k · 3 steps · 11 s | 3/3 · 198k · 4 · 10 s | 3/3 · 154k · 3 · 12 s |
| scroll/scroll-bottom | 3/3 · 185k · 4 steps · 11 s | 3/3 · 323k · 7 · 16 s | 3/3 · 154k · 3 · 10 s |
| scroll/load-more | 3/3 · 224k · 5 steps · 15 s | 3/3 · 408k · 9 · 20 s | 3/3 · 155k · 3 · 14 s |
| dynamic/wait-for-value | 3/3 · 109k · 2 steps · 12 s | 3/3 · 184k · 4 · 15 s | 3/3 · 194k · 4 · 24 s |
| dynamic/poll-status | 3/3 · 147k · 3 steps · 14 s | 3/3 · 146k · 3 · 15 s | 3/3 · 153k · 3 · 13 s |
| hard/multi-step-form | 3/3 · 224k · 5 steps · 16 s | 3/3 · 372k · 8 · 17 s | 3/3 · 280k · 6 · 34 s |
| hard/paginated-search | 3/3 · 343k · 8 steps · 26 s | 3/3 · 543k · 13 · 38 s | 3/3 · 196k · 4 · 18 s |
| hard/modal-trap | 3/3 · 224k · 5 steps · 21 s | 3/3 · 283k · 6 · 19 s | 3/3 · 236k · 5 · 17 s |
| **All 30 runs** | **30/30 · 5.80M tokens · 127 steps · 7.3 min · $2.51** | **30/30 · 8.80M · 196 · 9.3 min · $3.28** | **30/30 · 5.92M · 121 · 8.3 min · $2.91** |

**Finding.** All three pass everything and no run broke its guard. browser-layer and Browser Use are level: tokens within
2%, steps within 5% (Browser Use fewer), browser-layer 12% faster and 14% cheaper. Both use about a third fewer tokens and
steps than agent-browser. Browser Use is ahead on paginated-search and load-more, browser-layer on wait-for-value and
multi-step-form. Against the cursor-agent run above the lead over agent-browser is smaller (agent-browser took 196 steps
here, 391 there; a Claude Code step carries about 45k tokens, against about 22k). Medians of 3 runs, small fixture sites,
one agent; a tie with Browser Use, not a win.

### Head to head on Haiku: browser-layer against Browser Use 1.0 (12 Nov 2026)

Claude Code (`claude -p --model haiku`, tools Bash and Read only, project settings only) is the brain; the only thing that
changes is the browser tool, and the task text is the same for both. The 10 scenarios are web-agent-bench's (controlled,
scroll, dynamic, hard, their checks as they are), plus four listing-to-the-end tasks on this repo's fixture site
(`agents/site.mjs`): the sum of the Pending orders and the highest order (120 orders over 6 pages, a Next button), and the
Backorder count and the highest price of a 100-item catalog over 10 server-rendered pages (`rel=next`). 5 runs per
tool per task (more than the 3 asked for: a run costs under half a cent), 140 runs, concurrency 2, tools alternating order.
browser-layer is a packed build of this branch (`npm pack`, as `bench/local/run.mjs` installs it). Browser Use is
`browser-harness` 0.1.13 (the Browser Use 1.0 CLI), one headless Chrome per run. Both are held by a PreToolUse text filter
(`agents/guard.mjs`): browser-layer by web-agent-bench's own rules (live-tab commands only; no eval, net, cookies, storage,
login, plain-HTTP open/do, no file reads), Browser Use by the earlier run's (helpers and `js()` on the DOM; no imports,
files, processes, `cdp()`, `http_get`, network calls). A text filter, not a sandbox. A refused call is a step.
Rows: `results/h2h-haiku.jsonl` (140), `results/h2h-haiku-login-fix.jsonl` (5, below). Cells are passes · median steps (range)
· median tokens (input, cache and output) · median wall time (range) · mean usd.

| Task | browser-layer | Browser Use 1.0 |
|---|---|---|
| controlled/login | 5/5 · 3 steps (3–3) · 34k · 9 s (9–10) · $0.0017 | 5/5 · 4 steps (4–9) · 53k · 11 s (10–23) · $0.0031 |
| controlled/shop-filter | 5/5 · 3 steps (3–4) · 34k · 8 s (8–9) · $0.0018 | 5/5 · 4 steps (3–13) · 54k · 10 s (9–35) · $0.0033 |
| controlled/todos | 5/5 · 3 steps (3–6) · 34k · 11 s (10–15) · $0.0019 | 5/5 · 6 steps (6–9) · 82k · 23 s (15–29) · $0.0041 |
| scroll/scroll-bottom | 5/5 · 2 steps (2–6) · 25k · 9 s (7–16) · $0.0020 | 5/5 · 5 steps (4–5) · 65k · 12 s (9–20) · $0.0028 |
| scroll/load-more | 5/5 · 5 steps (4–5) · 56k · 14 s (14–16) · $0.0025 | 5/5 · 6 steps (5–14) · 84k · 25 s (19–49) · $0.0046 |
| dynamic/wait-for-value | 5/5 · 3 steps (3–4) · 34k · 11 s (10–18) · $0.0018 | 5/5 · 5 steps (3–6) · 65k · 14 s (11–36) · $0.0028 |
| dynamic/poll-status | 5/5 · 3 steps (3–3) · 34k · 11 s (11–16) · $0.0017 | 5/5 · 6 steps (6–6) · 77k · 23 s (17–29) · $0.0030 |
| hard/multi-step-form | 5/5 · 6 steps (5–8) · 66k · 18 s (17–26) · $0.0026 | 5/5 · 10 steps (9–14) · 153k · 29 s (25–43) · $0.0061 |
| hard/paginated-search | 5/5 · 11 steps (10–13) · 135k · 40 s (28–49) · $0.0046 | 5/5 · 14 steps (7–17) · 212k · 40 s (23–59) · $0.0070 |
| hard/modal-trap | 4/5 · 5 steps (5–5) · 54k · 18 s (17–25) · $0.0024 | 4/5 · 11 steps (4–13) · 154k · 31 s (13–39) · $0.0051 |
| orders-pending | 5/5 · 5 steps (4–11) · 62k · 21 s (18–38) · $0.0044 | 5/5 · 6 steps (5–6) · 92k · 21 s (20–26) · $0.0046 |
| orders-top | 5/5 · 4 steps (4–5) · 47k · 18 s (14–27) · $0.0030 | 5/5 · 5 steps (5–10) · 73k · 21 s (20–33) · $0.0047 |
| catalog-backorder | 5/5 · 5 steps (4–12) · 62k · 26 s (19–28) · $0.0039 | 5/5 · 5 steps (5–6) · 68k · 15 s (12–24) · $0.0035 |
| catalog-priciest | 5/5 · 4 steps (4–6) · 47k · 17 s (17–26) · $0.0028 | 5/5 · 5 steps (4–8) · 69k · 14 s (10–18) · $0.0037 |
| **All 70 runs** | **69/70 · 342 steps · 4.02M tokens · 20.5 min · $0.186** | **69/70 · 490 steps · 6.93M tokens · 25.9 min · $0.292** |

The `controlled/login` row for browser-layer is the rerun after the fix below; as first run it was 0/5 (2 steps, 25k).

**Finding.** Ahead of Browser Use on every cost measure, level on score. Both pass 69 of 70. browser-layer used 1.7× fewer
tokens (4.02M against 6.93M), 1.4× fewer steps (342 against 490), 21% less time (20.5 against 25.9 min) and 36% less money
($0.19 against $0.29). It is ahead on median steps in every scenario but one (catalog-backorder, level at 5); the gap is widest where the page does
the work: multi-step-form 6 against 10 steps, todos 3 against 6, poll-status 3 against 6, load-more 5 against 6.
On the four listing tasks the two are close (111 against 116 steps, browser-layer 7.4 against 6.5 min, but 17% fewer tokens): `get --all` answers
a 120-row table in one call, and Browser Use's agent writes a loop in Python that does the same in one script; browser-layer
is slower on the catalog tasks (26 s against 15 s, 17 against 14 s); in the transcripts Haiku first tried `--out` and `cd`
there, which the guard refuses, and retried; the time was not otherwise broken down. On Sonnet the earlier run was a tie;
the lead on Haiku is in steps and tokens, which this run does not explain further.

**Losses and their causes** (transcripts in each row's `dir`):
- `controlled/login`, browser-layer 0/5 (first run). Not an agent mistake: `help` said "never type passwords; a person runs
  `login <url>`", Haiku obeyed it although the task gave the username and password, called `login` (refused by the guard,
  which has no person to hand to) and answered that sign-in needs a person. Sonnet had typed the password anyway. A general
  flaw of the help text, not of the site: it now says a password the user gave in the task may be typed; any other stays
  with a person. Test first (`test/onboarding.test.ts`, failed before), 143 tests pass; the 5 reruns pass in 3 steps, 34k.
- `hard/modal-trap`, 4/5 for both tools. In each tool's failing run Haiku stopped at the cookie banner over "Account settings"
  and asked which button to click rather than choosing one. That is the model's caution, the same for both tools; browser-layer's
  answer named the banner's controls ("click one by name, then this again") and the agent still declined. Not changed.
- Where browser-layer was not ahead (orders-pending steps, catalog-backorder and catalog-priciest time): the guard. It refuses
  reading a file back (`wc`, `cd … &&`) and web-agent-bench's rules were written for agent-browser, so `--out` runs, which are
  how browser-layer keeps big answers out of context, cost a refused call each. Those 35 refusals (53 for Browser Use, mostly
  `cdp()` and imports) count as steps for both.

Caveats: one fixture site per scenario, answers exact; Haiku only; the guard is a text filter; 5 runs each, so ranges are shown. Spend: about $0.52
of the $3 (140 runs $0.48, the login rerun and a smoke test the rest) (runs under half a cent each with Bash and Read only, a small system prompt).
