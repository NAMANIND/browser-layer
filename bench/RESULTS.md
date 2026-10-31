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
local fixture apps (`agents/site.mjs`), two on live sites. Tools: agent-layer, Vercel agent-browser
0.41.0, Microsoft playwright-cli 0.1.22. Tokens include cache reads.

| Task | agent-layer | agent-browser | playwright-cli |
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

**Finding.** All three tools solve all eight tasks. agent-layer uses 36% fewer tokens than
agent-browser and 34% fewer than playwright-cli, with the fewest steps and least time. It is
cheapest on 6 of 8 tasks. It loses `orders` (pagination): agent-browser clicks "Next" by name in one
command, while agent-layer needs a ref from a fresh map each page, and the agent wasted steps there.

Caveats: one run each, so single-task differences within ~20% are noise; we wrote the fixtures.

### 3a. After fixing what the transcripts showed (agent-layer only, rerun)

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

With the reruns, agent-layer is cheapest on 7 of 8 tasks; shop is within noise of playwright-cli.
