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
