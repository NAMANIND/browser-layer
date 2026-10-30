# agent-layer — design

Status: draft for review · 31 Oct 2026 · replaces the earlier draft (MCP, compiler and replay are out of scope)

## 1. What it is

A complete web browser for agents that lives in the terminal. It does everything a browser does —
loads pages, runs their JavaScript, keeps logins, fills forms, opens pop-ups, uploads and downloads —
and gives the agent **text: what is on the page and what can be done**, never pixels.

The agent is the intelligence. It decides, remembers and optimizes (for example, reading `net` and
calling an API with `curl` next time). This tool is the browser, not a second agent.

### Principles

1. **Standards over cases.** Every rule comes from a spec the browser implements (WAI-ARIA, HTML-AAM,
   Accessible Name Computation, the HTML form submission algorithm, CSSOM, HAR) or is a named policy
   value in one file. No code exists because one site behaved a certain way.
2. **Know before triggering.** What the page will reveal (hover menus, collapsed sections, popups) is
   read from its structure first. Events are fired only for content that does not exist yet.
3. **No pixels, minimum rendering work.** The agent never gets pixels. Decoration (images, fonts,
   media, animation) is never loaded. Painting is removed when we own the engine (§8).
4. **Fast because of less, not because of tricks.** Fewer bytes, fewer steps, deltas instead of
   full re-reads.

### Out of scope

MCP or other agent protocols (the agent has a terminal), learning and replay inside the tool,
screenshots and vision, cloud or multi-user hosting, anti-bot evasion.

## 2. Evidence this design rests on

From `bench/RESULTS.md` (five live sites, 31 Oct 2026):

- The engine's accessibility tree builds in **35–87 ms** and already marks rows and list items.
- Cutting decoration keeps the page **identical** and saves **13–36%** of bytes (Amazon loads 2.7× faster).
- Cutting all CSS **breaks pages** (Google Flights lost 42 controls; GitHub surfaced 65 hidden ones).
  CSS that carries meaning stays.
- Painting costs **70–220 ms** of CPU per load: worth removing at scale, not a blocker today.

## 3. Architecture

```
 agent (any LLM with a terminal)
   │  agent-layer <command>          text out, --json for programs
 ┌─┴───────────────────────────────────────────────────────────┐
 │ CLI            parse args, print. No logic.                   │
 ├─────────────────────────────────────────────────────────────┤
 │ DAEMON         sessions · tabs · ordering · policy · storage  │
 ├──────────────────┬──────────────────┬───────────────────────┤
 │ READER           │ ACTIONS          │ EVENTS & NETWORK       │
 │ AX tree + layout │ actionability,   │ dialogs, popups,       │
 │ → Node tree,     │ trusted input,   │ downloads, HAR log     │
 │ reveal map       │ settle contract  │                        │
 ├──────────────────┴──────────────────┴───────────────────────┤
 │ ENGINE   chromium (headless now, own no-paint build later)    │
 │          http (plain fetch for static pages, same commands)   │
 └─────────────────────────────────────────────────────────────┘
 RENDERER (text for the agent, JSON for programs) reads Node trees only.
```

Each layer depends only on the layers below. The CLI never talks to an engine.

## 4. The reader

### 4.1 Sources

Each fact comes from the browser source that is authoritative for it:

- **What is rendered:** `DOMSnapshot` — the DOM in document order, which nodes have a layout box, the
  rendered text of each text node (and of `::before` / `::after` / `::marker`), computed `display`,
  `visibility`, `opacity`, and attributes.
- **What things are:** the accessibility tree (CDP `Accessibility`) — roles, names (Accessible Name
  Computation), values and states, as the browser maps ARIA and HTML. We never reimplement those specs.
- **Identity:** the browser's `backendNodeId`. The agent sees small numbers (`[12]`); the daemon maps
  each to a node id per tab, never reuses a number, and drops the map when the document changes.
  Nothing is written into the page.

The accessibility tree alone is not enough: it omits the text of `aria-hidden` content, and sites put
visible facts there (Google Flights' times, airports and prices).

### 4.2 Rules

1. Text is shown when its node has a layout box and no ancestor is `visibility: hidden` or
   `opacity: 0`.
2. A control (ARIA widget role) gets a ref when it has a layout box. Its text children are its name
   and are not repeated, unless they contain other controls.
3. `aria-hidden="true"` (WAI-ARIA): the subtree's text is shown, its controls get no ref.
   `inert` (HTML): the subtree is not shown. Both read from the attribute, as the specs define them.
4. Lines follow CSS: an element whose `display` is not inline-level starts a new line. Elements with a
   row role (`row`, `listitem`, `option`, `menuitem*`, `treeitem`) are one line, with ` · ` between
   their blocks. Headings print with their level (`## Title`).
5. Images are not shown; their alt text is the name of the control they sit in.
6. Frames, same-origin and cross-origin, are read through their own engine targets and attached under
   their `iframe` node (P3).
7. Canvas apps: text drawn with `CanvasRenderingContext2D.fillText` is recorded by a document-start
   hook and attached to the canvas node with positions (P4).

Known gaps: elements made clickable only by a script listener with no ARIA role get no ref; content
made inert implicitly by a modal `<dialog>` is still shown.

### 4.3 The reveal map (know before triggering)

For each control, what it will reveal, from the strongest source available:

| Source | Standard | Reveals |
|---|---|---|
| `aria-controls`, `aria-owns`, `aria-haspopup`, `aria-expanded` | WAI-ARIA | The popup element, already in the DOM: its items are listed under the control |
| `<details>` / `<summary>`, `popovertarget`, `<dialog>` | HTML | The hidden content, listed under the trigger |
| `:hover` / `:focus-within` rules whose target is hidden | CSSOM | The element those rules show, listed under the trigger |
| `mouseenter` / `mouseover` / `pointerenter` / `focus` listeners | DOM events (document-start hook on `addEventListener`) | Marked "reveals on hover/focus"; content unknown until triggered |

Content that only exists after the event fires (rendered or fetched on hover) is marked, and the
`hover` / `focus` actions trigger it and return what appeared. Frameworks that delegate events to the
root are covered by the first three sources; the fourth reports only that the page reacts.

### 4.4 Deltas

Every snapshot has a generation. Actions return what changed since the previous generation (added,
removed, changed nodes by ref). A full read is always available with `read`.

## 5. Actions

### 5.1 Actionability

Before acting: attached, has a box, stable across two frames, enabled, and it receives the pointer at
its center (hit test against layout). Failures name the reason: `hidden`, `disabled`, `covered by
[ref]`, `detached`. Implemented through the engine adapter (Playwright's actionability model).

### 5.2 Input

Trusted input through the engine (CDP `Input.*`). Hit testing uses layout, not pixels, so it works with
painting off.

### 5.3 Settle contract

An action is settled when no navigation is in flight, no document/fetch/XHR request is in flight
(long-lived WebSocket, EventSource and streamed responses excluded, as classified by the engine), and
the DOM has been quiet for the policy window — or the policy deadline passes. The result states which
(`idle`, `deadline`, `navigation`) and how long it took.

## 6. Browser coverage

| Capability | Commands |
|---|---|
| Navigation | `tab <url>`, `go <url>`, `back`, `forward`, `reload`, `tabs`, `use`, `close` |
| Reading | `read [--page N]`, `find <text>`, `text <ref>`, `wait <text \| ref \| gone:ref>` |
| Pointer | `click`, `dblclick`, `rightclick`, `hover`, `drag <ref> <ref>` |
| Keyboard | `type <ref> <text>`, `fill <ref> <text>`, `press <keys>` (combos: `Control+A`, `Shift+Tab`) |
| Form | `check`, `uncheck`, `pick <ref> <option>`, `upload <ref> <file…>`, `submit <ref>` |
| Scroll | `scroll <ref \| page> [down \| up \| to-end]`, infinite scroll via repeated `to-end` with settle |
| Dialogs | `alert` / `confirm` / `prompt` / `beforeunload` are surfaced in the result; `dialog accept [text] \| dismiss` |
| Windows | Pop-ups and `target=_blank` open as new tabs in the same session and are reported |
| Downloads | Saved to the session's download dir, reported with path and size; `downloads` lists them |
| Frames | Read and act inside frames by ref, cross-origin included |
| Storage | `cookies [--domain]`, `storage local \| session [--origin]`, `eval <js>` |
| Network | `net [--all]` (HAR entries), `net show <id>` (headers, body) |
| Permissions | Geolocation, notifications, clipboard: policy grants or denies; prompts reported |
| Profiles | One persistent profile per name; `--profile`; import cookies from the user's Chrome profile |

## 7. Engines

| Engine | Use | Notes |
|---|---|---|
| `chromium` | Default | Installed Chrome, headless. Playwright for lifecycle and actionability, raw CDP for the accessibility tree, DOMSnapshot and network. Images, fonts and media never requested; `prefers-reduced-motion` on and animations/transitions disabled. |
| `http` | Static pages, forms | parse5 (spec-compliant HTML parsing), HTML-AAM implicit roles, the HTML form submission algorithm. Detects a client-rendered shell and says to use `chromium`. Same commands where they apply; `ENGINE_UNSUPPORTED` otherwise. |

## 8. Owning the engine (later)

When many tabs run at once, the 70–220 ms of paint per load becomes a real cost. Then:
`chrome-headless-shell` first (Chromium's own stripped build), then our own build of it with paint,
raster and compositing removed after layout. It replaces the `chromium` engine behind the same
adapter; nothing above changes. Decision point: measured CPU per tab at the parallelism we need.

## 9. Policy (`src/policy.ts`, documented, tested)

Keys are added when the phase that uses them lands.

| Key | Default | Meaning |
|---|---|---|
| `settle.quietMs` | 400 | DOM quiet window |
| `settle.deadlineMs` | 5000 | Max wait after an action |
| `render.pageChars` | 15000 | Text page size |
| `render.maxChars` | 400000 | Ceiling on one snapshot |
| `render.nameChars` | 120 | Name and link-path cap in text only |
| `network.hide` | tracker list (data file) | Hidden from `net` unless `--all` |
| `permissions` | deny all | Per-origin grants |
| `sessions.max` | 8 | Parallel sessions |
| `load.timeoutMs` | 30000 | Navigation timeout |
| `viewport.width` / `.height` | 1280 / 900 | Layout size; decides responsive variants |
| `network.keep` | 300 | Requests kept per tab |
| `daemon.idleMs` | 1800000 | Idle shutdown |

## 10. Runtime and storage

- Daemon per user, started on demand, single instance (lock + liveness), owner-only socket on a short
  path, idle shutdown, `stop` returns after the engine exits.
- `~/.agent-layer/<profile>/`: browser profile, downloads, HAR logs (bounded, `Cookie` /
  `Authorization` / `Set-Cookie` redacted before disk), daemon log.
- The `http` engine reads and writes cookies through the browser profile; no separate jar file.

## 11. Quality

- Spec conformance tests: accessible names, HTML form submission, ARIA reveal patterns.
- Recorded corpus (HAR of real pages, seeded `Math.random`) replayed offline, so measurements are deterministic.
- Live checks against real sites on demand (`npm run live`), never blocking the build.
- Budgets per commit: read p95 under 150 ms on the corpus; no regression in `bench/` numbers.
- A behavior change lands with a failing test first and before/after numbers.
