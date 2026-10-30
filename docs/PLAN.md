# agent-layer — build plan

Goes with [DESIGN.md](DESIGN.md). Each phase ends green and measured before the next starts.
Every phase lands as small commits; each behavior change comes with a failing test first.

## Where we are (31 Oct 2026)

Working: fast path (`open`, `do`, `verbs`), live tabs over a daemon (`tab`, `read`, `click`, `type`,
`pick`, `press`, `net`), sessions, shared cookies, paging. 13 tests green.

Built on heuristics that this plan removes:

| Current code | Replaced in | By |
|---|---|---|
| `snapshot.ts` `roleOf` / `nameOf` | P1 | Engine accessibility tree |
| `data-al` attributes written into pages | P1 | `backendNodeId` refs |
| `isRow` box-geometry row detection | P1 | Semantic roles (`row`, `listitem`, …) in the text renderer |
| `destOf` "show link when useful", 45/80 name caps | P1 | Renderer policy (`render.*`), JSON never cut |
| `aria-hidden` / `inert` special cases | P1 | DESIGN §4.2 rules 1, 2, 4 |
| `NOISE` regex in `daemon.ts` | P3 | Engine resource types + bundled tracker list |
| 400 ms quiet `settle` | P2 | Settle contract (DESIGN §5.3) |
| `page.ts` form reader | P4 | HTML form submission algorithm on parse5 |
| `cookies.json` copy between engines | P2 | One store through the engine, encrypted export |
| Ad-hoc CLI ↔ daemon JSON | P0 | JSON-RPC protocol |

## P0 — Protocol skeleton

- `src/protocol/`: TS types from DESIGN §3, JSON Schema generated from them, error codes.
- Daemon speaks JSON-RPC 2.0 with `initialize`. CLI becomes an adapter over it; command names stay.
- Corpus: record HN, Google Flights (results), GitHub repo page, the local fixtures as MHTML + HAR
  under `test/corpus/`, with a loader that serves them offline.
- Measurement script: `npm run measure` prints snapshot ms, lines, chars per corpus page.

**Exit:** all current tests pass through the protocol; `measure` produces a baseline file in-repo.

## P1 — Semantic layer on the accessibility tree

- `src/semantic/`: AX tree + DOMSnapshot → `Node` (DESIGN §4.1, §4.2). Refs are `generation:backendNodeId`.
- `src/render/text.ts`: rows by role, controls inline, headings own lines, paging, `render.*` policy.
- Actions resolve refs through `DOM.resolveNode` from `backendNodeId`.
- Delete `snapshot.ts` and every row in the table above marked P1.

**Exit:** corpus snapshots are at least as complete as the baseline (every flight row with airports and
price, every HN story with its points line), p95 under 150 ms, zero writes to page DOM, all tests green.

## P2 — Actions and the settle contract

- Actionability via the engine adapter; `NOT_ACTIONABLE` reasons.
- Settle contract with reported reason; policy file `src/policy/defaults.json` with tests per key.
- Responses carry the snapshot delta, not a full re-read.
- Cookie store: `http` engine reads/writes through the Chromium profile store; encrypted export via
  OS keychain key; `cookies.json` removed.

**Exit:** a test page that never goes quiet returns `settled.reason = deadline` in `deadlineMs`; a
fetch-driven page returns `idle`; deltas are smaller than full snapshots on every corpus action.

## P3 — Recorder

- HAR 1.2 recording per target, initiator + causing action, redaction before disk, rotation.
- Classification by resource type + bundled tracker list; `network.list` filters on it.

**Exit:** Google Flights search recording opens in a standard HAR viewer; no `Cookie` /
`Authorization` values on disk; tracker filter has zero hand-written patterns.

## P4 — HTTP engine on the specs

- parse5; HTML-AAM implicit roles for snapshot nodes; form submission algorithm for verbs.
- Client-rendered shell detection → error that names the `chromium` engine.
- Conformance tests from the form submission spec cases.

**Exit:** form conformance cases pass; corpus HTML pages produce the same node roles as the
`chromium` engine for static content.

## P5 — Compiler and replay

- Dataflow analysis over recordings (DESIGN §7.3); Route format with JSON Schema; route store.
- `replay` engine with response shape validation and fallback.
- First routes: Google Flights search, Hacker News front page, the local booking fixture.

**Exit:** Flights search by route returns the same results as the live run; replay p95 under 500 ms;
a deliberately broken route falls back to live and recompiles.

## P6 — Adapters and packaging

- MCP server: tools map 1:1 to protocol methods, generated from the schema.
- TypeScript SDK from the same schema.
- `npx agent-layer` install path; Chrome / headless-shell detection with a clear message.

**Exit:** Claude Code completes the Flights task through MCP with no CLI involved.

## P7 — Hardening

- Policy-gated irreversible actions (`POLICY_DENIED` / `confirm`).
- Structured logs, `runtime.trace`.
- Live canaries on a schedule; budgets tracked per commit.

**Exit:** canaries green for a week; security checklist in DESIGN §11 verified by tests.

## Not on this plan

Chromium fork or a no-paint build, cloud hosting, multi-user, vision, anti-bot evasion.
