# agent-layer

[![ci](https://github.com/NAMANIND/agent-layer/actions/workflows/ci.yml/badge.svg)](https://github.com/NAMANIND/agent-layer/actions/workflows/ci.yml)

A terminal browser for AI agents. A page comes back as a short text map of its regions and controls,
every action answers with what changed, and lists and tables come back as records. No screenshots,
no DOM dumps.

On the same tasks, same model and same rules, agent-layer took about half the steps of Vercel's
agent-browser and used 3.4× fewer tokens ([benchmarks](bench/RESULTS.md)).

## Install

Needs Node.js 22 or newer, on macOS, Linux or Windows.

```bash
npm install -g agent-layer
agent-layer browser        # which browser it will drive
```

agent-layer drives a browser you already have: Google Chrome, then Microsoft Edge, then Chromium,
whichever it finds first (every Windows machine has Edge). To pick one, set `AGENT_LAYER_BROWSER` to
its executable. On a machine with none, such as a server or a container, download Chromium once:

```bash
agent-layer install              # macOS, Windows, or Linux with the system libraries present
agent-layer install --with-deps  # Linux: also installs the libraries Chromium needs (uses sudo)
```

## Use

```bash
agent-layer tab google.com/travel/flights   # opens a live tab; answers with the page map
agent-layer type 15 Mumbai                  # answers with what changed
agent-layer click "Search"                  # a control by ref or by name
agent-layer read 231                        # one region in full
agent-layer get 233 --sort c11 --limit 3    # a list or table as records (TSV)
agent-layer net                             # the API calls the page made
agent-layer stop
```

`agent-layer help` lists every command. A background daemon keeps the browser and its tabs alive
between commands and exits after 30 idle minutes. Its state (profile, cookies, last page) lives in
`~/.agent-layer`, or `AGENT_LAYER_HOME`.

**Fast path** (`open`, `do`, `verbs`): plain HTTP, no browser at all. It works when the content and
forms are in the HTML the server sends; pages built by JavaScript need a live tab.

**Signing in**: `agent-layer login <url>` opens a normal browser window on the agent's profile. You
sign in yourself (passwords, 2FA and passkeys stay with you), close it, and the agent stays signed in.

**Watching**: `agent-layer show` turns the agent's browser into a visible window; `agent-layer hide`
makes it headless again.

## Develop

```bash
npm install
npm run build
npm test          # unit and live tests; the live tests drive the browser agent-layer finds
```

CI runs the build and every test on Linux, macOS and Windows with Node 22 and 24.

The reader's speed benchmark replays recorded pages of real sites. Those recordings stay on your
machine: make them once with `node bench/record-corpus.mjs`, then run `npm run measure`.

## License

Copyright 2026 Naman Rai. Licensed under Apache-2.0; see [LICENSE](LICENSE).
