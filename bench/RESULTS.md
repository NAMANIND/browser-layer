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
