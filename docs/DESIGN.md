# agent-layer — design

Status: draft for review · 31 Oct 2026

## 1. What the product is

A local runtime that gives AI agents the web as **semantic nodes and verbs**, not pixels or raw HTML.
An agent asks for a page and gets what is on it and what can be done with it. It acts by reference.
Over time the runtime learns what each action does on the network and replays that directly, so a
task the agent has done before takes one request instead of a page load and a dozen clicks.

It runs on the user's machine, in the user's logged-in sessions, behind one protocol that any agent
can speak (MCP, CLI, or a library).

### Goals

1. **Standards, not site cases.** Every rule traces to a spec the browser already implements
   (WAI-ARIA, HTML-AAM, Accessible Name Computation, the HTML form submission algorithm, HAR) or to a
   named, documented policy. No code that exists because one site behaved a certain way.
2. **One protocol, several engines.** Plain HTTP, a live Chromium, and compiled replay all answer the
   same requests. Agents never care which one ran.
3. **Learn once, replay fast.** The live engine records what actions send; the compiler turns that into
   parameterized routes; replay runs them without a page.
4. **Safe in a real profile.** Local only, owner-only access, secrets encrypted at rest, irreversible
   actions declared and gated.

### Non-goals (for now)

- Pixels, screenshots, vision models.
- Running in the cloud or for many users. Single user, single machine first.
- Beating anti-bot systems. When a site refuses automation, we report it; we do not evade it.
- Forking Chromium. The engine boundary keeps that possible later; it is not on this plan.

## 2. Architecture

```
 Agents: Claude Code, Cursor, scripts
   │
 ┌─┴──────────────────────────────────────────────────────────────────────┐
 │ ADAPTERS        MCP server · CLI · TypeScript SDK        (no logic)      │
 ├────────────────────────────────────────────────────────────────────────┤
 │ PROTOCOL        JSON-RPC 2.0 · versioned schema · capability negotiation │
 ├────────────────────────────────────────────────────────────────────────┤
 │ RUNTIME         sessions · targets · scheduler · policy · storage · log  │
 ├──────────────┬──────────────────────┬──────────────────────────────────┤
 │ SEMANTIC     │ ACTIONS + SETTLE     │ RECORDER → COMPILER → ROUTES      │
 │ AX tree +    │ actionability,       │ HAR capture, dataflow analysis,   │
 │ layout → Node│ trusted input,       │ parameterized requests            │
 │              │ settle contract      │                                   │
 ├──────────────┴──────────────────────┴──────────────────────────────────┤
 │ ENGINES   http (fast path) · chromium (CDP) · replay (compiled routes)   │
 └────────────────────────────────────────────────────────────────────────┘
 RENDERERS sit beside the protocol: text for LLMs (budgeted, paged), JSON for programs.
```

Dependency rule: each layer depends only on the ones below it. Adapters never touch engines.
Renderers read protocol types only.

## 3. Protocol

JSON-RPC 2.0 over a Unix socket (and stdio for MCP). The shape follows LSP and MCP so anyone who
knows those can read it; nouns follow the Chrome DevTools Protocol (targets, nodes, frames).

### 3.1 Lifecycle

- `initialize { protocolVersion, client, capabilities }` → `{ protocolVersion, engines, capabilities }`.
  Major version mismatch is an error; minor differences are negotiated through capabilities.
- Every request carries `session`. A session owns its targets and last snapshot. Sessions share the
  cookie store of their profile.

### 3.2 Core types

```ts
Target   { id, session, engine: 'http' | 'chromium' | 'replay', url, title }
Snapshot { target, generation, url, title, root: Node, truncated: boolean }
Node     { ref, role, name?, description?, value?, states: State[], url?, level?,
           children?: Node[], text?: string }
State    'focused' | 'disabled' | 'checked' | 'mixed' | 'selected' | 'expanded' | 'collapsed'
         | 'required' | 'invalid' | 'readonly' | 'busy' | 'modal'
Ref      `${generation}:${backendNodeId}`  (opaque to clients)
Verb     { name, method, url, inputs: Input[], source: 'form' | 'route' }
Request  { method, url, status, type, requestBody?, initiator, timing }   (HAR entry subset)
```

Roles and states are the WAI-ARIA vocabulary as computed by the engine, not invented names.

### 3.3 Methods

| Method | Purpose |
|---|---|
| `target.open { url, engine? }` | New target. Engine defaults by policy: try `replay`, then `http`, then `chromium`. |
| `target.navigate / back / close / list / use` | Standard navigation. |
| `snapshot.get { target, mode: 'full' \| 'delta', since? }` | The semantic tree, or changes since a generation. |
| `node.click / fill / select / press / check / scroll / upload { ref, ... }` | Actions by ref. |
| `verb.list / verb.run { name, inputs }` | Declared verbs: HTML forms and compiled routes. |
| `network.list { target, filter }` | Recorded requests (HAR subset). |
| `route.compile { from: requestIds } / route.list / route.run` | The compiler surface. |
| `session.*`, `runtime.stop` | Housekeeping. |

Every action returns `{ snapshot | delta, settled: { ok, reason, ms }, navigated?, dialog? }`, so an
agent never has to call `snapshot.get` right after acting.

### 3.4 Errors

Stable codes, JSON-RPC style: `STALE_REF`, `NOT_ACTIONABLE` (with reason: hidden, disabled, covered,
detached), `NO_TARGET`, `WRONG_SESSION`, `TIMEOUT`, `NAVIGATION_FAILED`, `ENGINE_UNSUPPORTED`,
`POLICY_DENIED`, `ROUTE_MISMATCH`. Messages say what to do next.

## 4. Semantic layer

### 4.1 Source of truth

- **Structure, roles, names, states:** the engine's accessibility tree
  (`Accessibility.getFullAXTree`). The browser already implements the specs; we do not reimplement
  them. Spike, 31 Oct: 35–87 ms on HN, Google Flights and GitHub.
- **Geometry and on-screen state:** `DOMSnapshot.captureSnapshot` with layout rects. Spike: 8–73 ms.
- **Identity:** `backendNodeId`. Stable for the life of the node, invisible to the page. We never write
  attributes into the site's DOM.

### 4.2 Rules

1. A node is included if the accessibility tree does not mark it ignored **and** it has a layout box.
2. Visible text that the page hides from assistive tech (`aria-hidden`) is still on screen. It is
   attached as `text` on its nearest included ancestor, with no ref. This is one documented rule, applied
   everywhere, sourced from layout text boxes.
3. Wrapper nodes with role `generic` / `none` and no name are flattened into their parent.
4. `inert` and `display:none` content is excluded; the engine already reports it ignored.
5. Frames: same-origin and cross-origin frames are walked through their own targets and grafted in as
   children of the `iframe` node. Refs carry the frame.

### 4.3 Deltas

Each snapshot has a `generation`. `mode: 'delta'` returns added, removed and changed nodes by ref since
`since`. First implementation diffs two full snapshots; `Accessibility.nodesUpdated` events replace that
when stable. Deltas are what make long sessions cheap for the model.

## 5. Actions and the settle contract

### 5.1 Actionability

Before acting on a ref: attached, visible, stable (box unchanged across two frames), enabled, and it
receives the pointer at its center (hit test). Failure returns `NOT_ACTIONABLE` with the reason. This is
the model Playwright established; we use its implementation through the engine adapter, not our own.

### 5.2 Input

Trusted input only (CDP `Input.*`), the way a user's events arrive. `fill` replaces the value and fires
`input` and `change`; `type` sends key events for sites that listen to keys. `select` follows the
`<select>` element or the ARIA listbox/option pattern.

### 5.3 Settle

An action is settled when all of these hold, or the policy deadline passes:

- no navigation in flight (`Page.lifecycleEvent`, `frameNavigated`),
- no in-flight `fetch` / `XHR` / document requests, excluding long-lived ones (WebSocket,
  EventSource, streamed responses) as classified by the engine,
- no DOM mutations for the policy quiet window.

The result always says which condition ended the wait (`idle`, `deadline`, `navigation`), so an agent
or a test can tell a settled page from a page that never went quiet. Numbers live in policy (section 9).

## 6. Engines

| Engine | Implements | Notes |
|---|---|---|
| `http` | `target.open/navigate`, `snapshot.get`, `verb.*` | Parses HTML with a spec-compliant parser (parse5). Forms follow the HTML **form submission algorithm**: submitter, `form=` owner, disabled fieldsets, `dirname`, all three enctypes. Snapshot nodes use HTML-AAM implicit roles. |
| `chromium` | everything | Playwright for browser lifecycle and actionability; raw CDP sessions for accessibility, DOMSnapshot and network. Installed Chrome by default; `chrome-headless-shell` when available. |
| `replay` | `route.run`, `verb.run`, `snapshot.get` for routes that return documents | Sends compiled routes over HTTP with the session's cookies. Validates the response shape; on mismatch returns `ROUTE_MISMATCH` and the runtime falls back to `chromium`. |

An engine declares its capabilities; the runtime refuses methods an engine cannot serve with
`ENGINE_UNSUPPORTED` instead of degrading silently. The `http` engine detects a client-rendered shell
(empty body plus scripts) and says so.

## 7. Recorder, compiler, routes

1. **Record.** The `chromium` engine records every request as a HAR 1.2 entry, with initiator and the
   action (ref + method) that caused it. HAR is the standard; any tool can read our recordings.
2. **Classify.** Requests are classified by the engine's resource type and a maintained tracker list
   (data file, versioned, e.g. a public tracker list), never by hand-written patterns.
3. **Compile.** For the requests an action caused, dataflow analysis finds where every value came
   from: a user input, an earlier response, a cookie, a page constant. Values from user input become
   route inputs; values from earlier responses become dependency steps; constants stay constants.
   Output: a **Route** — inputs, ordered request templates, extraction rules, expected response shape.
4. **Replay.** Routes run on the `replay` engine. Each run is checked against the expected shape.
   A mismatch marks the route stale and falls back to live; the next live run recompiles.
5. **Store.** Routes are versioned per site in the profile, keyed by origin. They contain no cookies
   or secrets, only templates.

URL-encoded state (for example a search encoded in a query parameter) is a special case of the same
analysis, not a separate feature.

## 8. Runtime

- **Daemon** per user, started on demand, one per profile, single instance by lock + liveness check.
  Socket in a short path, mode 0600. Idle shutdown.
- **Scheduler.** Commands within a session run in order. Sessions run in parallel up to a policy limit.
- **Profiles.** One Chromium profile per agent-layer profile. The `http` engine reads and writes the
  same cookie store through the engine (one jar, no file copy).
- **Storage.** `~/.agent-layer/<profile>/`: browser profile, routes, recordings (bounded, rotated),
  logs. Secrets (cookies exported for `http`) encrypted with a key in the OS keychain.
- **Observability.** Structured JSON logs with request ids; `runtime.trace` returns the last N protocol
  calls with timings for a session.

## 9. Policy (data, not code)

One file, defaults shipped, overridable per profile, each entry documented and tested:

| Key | Default | Meaning |
|---|---|---|
| `settle.quietMs` | 300 | DOM quiet window |
| `settle.deadlineMs` | 8000 | Max wait after an action |
| `render.pageChars` | 15000 | Text renderer page size |
| `render.nameChars` | 120 | Text renderer name cap (JSON is never cut) |
| `network.trackers` | bundled list | Requests hidden from `network.list` by default |
| `engine.order` | replay, http, chromium | Engine choice for `target.open` |
| `actions.confirm` | purchase, send, delete, publish | Verbs that need explicit confirmation |
| `sessions.max` | 8 | Parallel sessions |

## 10. Renderers

- **Text** (for LLMs): one line per semantic row (`row`, `listitem`, `option`, `menuitem`, `article`,
  table rows), controls inline as `[ref] role "name" states`, headings as their own lines, paged by
  `render.pageChars` on line boundaries. Shortening happens here and only here.
- **JSON**: the protocol types as is.

## 11. Security

- Local socket, owner-only. No network listener.
- Cookies and tokens never in logs, recordings are redacted (`Authorization`, `Cookie`, `Set-Cookie`,
  known token parameters) before they touch disk.
- Irreversible actions (policy `actions.confirm`) return `POLICY_DENIED` unless the call carries
  `confirm: true`; adapters surface that to the human.
- Routes never store credentials.

## 12. Quality

- **Conformance tests** against the specs we rely on: accessible name cases, HTML form submission
  cases, HAR shape.
- **Recorded corpus**: real pages saved as MHTML + HAR (Google Flights, Hacker News, GitHub, a
  login form, a SPA), replayed offline so the suite is deterministic.
- **Live canaries**: the same tasks against the live sites, run on a schedule, failures reported,
  never blocking a build.
- **Budgets**: snapshot p95 under 150 ms on the corpus; replay route p95 under 500 ms; tracked per
  commit.
- Every behavior change lands with a failing test first and before/after numbers on the corpus.

## 13. Decisions to confirm

1. **Playwright + raw CDP** for the `chromium` engine (recommended) vs raw CDP only. Playwright gives
   proven actionability and lifecycle; CDP gives the semantic and network data. Revisit if Playwright
   blocks the headless shell or a patched build.
2. **parse5** for the `http` engine (spec-compliant HTML parsing) replacing node-html-parser.
3. **Protocol name and version 0.1** published in-repo as a JSON Schema generated from the TS types.
