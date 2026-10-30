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
| `snapshot.ts` `roleOf` / `nameOf` | P1 | Engine accessibility tree |
| `data-al` attributes written into pages | P1 | `backendNodeId` refs |
| `isRow` geometry check | P1 | Row roles (`row`, `listitem`, `option`, `menuitem`, `article`) in the renderer |
| `destOf`, the 45 / 80 name caps | P1 | `render.*` policy, applied in the text renderer only |
| `aria-hidden` / `inert` handling | P1 | DESIGN §4.2 rules 1–2 |
| `--blink-settings=imagesEnabled=false` | P1 | `load.block` + `load.motion` policy |
| 400 ms quiet `settle` | P2 | Settle contract, DESIGN §5.3 |
| `NOISE` regex | P3 | Engine resource types + tracker list data file |
| `page.ts` form reader, node-html-parser | P5 | parse5 + HTML form submission algorithm |
| `cookies.json` | P5 | `http` engine uses the browser profile's cookies |

## P0 — Foundations

- `src/policy/`: defaults file + loader + a test per key.
- Corpus: save HN, Google Flights results, GitHub repo, Amazon search, TodoMVC, and the local fixtures
  as MHTML + HAR under `test/corpus/`; a server that replays them offline.
- `npm run measure`: read time, lines, chars, controls per corpus page → `bench/results/baseline.json`.

**Exit:** baseline committed; current tests green; corpus pages load offline.

## P1 — Reader on the accessibility tree

- `src/reader/`: AX tree + DOMSnapshot → `Node` tree (DESIGN §4.1–4.2), refs from `backendNodeId`,
  frames attached, `aria-hidden` visible text attached without refs.
- `src/render/text.ts`: rows by role, controls inline, headings on their own lines, paging,
  `render.*` policy.
- Actions resolve refs through `DOM.resolveNode`.
- Engine loads with `load.block` and `load.motion`.
- Delete `snapshot.ts` and every P1 row above.

**Exit:** on the corpus, every fact in the baseline is still present (each flight row with times,
airports and price; each HN story with its points line); read p95 under 150 ms; zero DOM writes to
pages; all tests green.

## P2 — Actions and settle

- Actionability with named failure reasons; trusted input for every pointer and keyboard command in
  DESIGN §6.
- Settle contract with reported reason; deltas returned by every action.

**Exit:** a never-quiet page reports `deadline` within the policy deadline; a fetch page reports
`idle`; every action on the corpus returns a delta smaller than a full read.

## P3 — Events, windows, files, network

- Dialogs surfaced and answered; pop-ups and `target=_blank` as tabs; downloads saved and listed;
  `upload`.
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
