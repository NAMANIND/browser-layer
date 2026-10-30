# agent-layer

Websites as text and verbs for agents. No browser, no CSS, no paint.

```bash
npm install && npm run build && npm link   # installs the agent-layer command
node dist/cli.js open example.com                 # read a page
node dist/cli.js open 3                           # follow link [3] from the last page
node dist/cli.js verbs                            # forms on the last page, as verbs
node dist/cli.js do contact.submit name=Naman email=n@x.com
node dist/cli.js do post topping=bacon,onion      # checkbox groups: comma-separated
```

`--json` prints structured output. Cookies and the last page live in `~/.agent-layer` (override with `AGENT_LAYER_HOME`).

## Two paths

**Fast path** (`open`, `do`, `verbs`): plain HTTP, no browser. Works when content and forms are in the HTML the server sends. It does not run JavaScript, so apps built in the browser show up nearly empty.

**Live tabs** (`tab`, `read`, `click`, `type`, `pick`, `press`, `net`, ...): a background daemon keeps headless Chrome tabs alive between commands, so the page's JavaScript runs. Every control gets a stable `[ref]`. `net` shows the API calls the page made, which is what a later compile step can replay without the tab.

```bash
node dist/cli.js tab google.com/travel/flights   # answers with the page map
node dist/cli.js type 15 Mumbai                  # answers with what changed
node dist/cli.js click 77
node dist/cli.js read 231                        # one region in full
node dist/cli.js get 233 --sort c11 --limit 3    # a list or table as records
node dist/cli.js net
node dist/cli.js show                            # watch the agent's browser in a window (hide: headless)
node dist/cli.js login accounts.google.com       # sign in yourself; the agent stays signed in
node dist/cli.js stop
```

Needs Google Chrome installed. The daemon exits after 30 idle minutes.

Next: compile recorded requests into verbs and replay them without the tab, then an MCP server over the same commands.
