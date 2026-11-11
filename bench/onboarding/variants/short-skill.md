---
name: browser-layer
description: >-
  Browse and act on websites from the terminal with the browser-layer CLI: open pages, read them
  as a short text map, click, type, fill forms, read lists and tables as records, follow pagination,
  download files, and see the API calls a page makes. Use for any task on a website — research,
  extracting data, filling forms, testing a web app, checking a flow — instead of curl, scraping
  HTML by hand, or screenshots.
license: Apache-2.0
allowed-tools: Bash(browser-layer:*)
---

# browser-layer

A page comes back as a text map of its regions and controls, each with a ref. Read pages as text,
never as pictures. `browser-layer help` lists every command; run it once before the first call.

## How to work

- One call per decision: look, decide, do everything you decided in one call, look at the result.
  Every action's answer is the new state: no `map` or `read` after it.
- Many pages: one call, never a shell loop. A big result goes to a file (`--out`), not your context.
- The data usually comes from an API; look at the page's requests before scraping the screen.
- A list is complete only when you can show it ended (the site's total, no Next, or nothing new
  after scrolling three times). Until then say how many of how many.
- When the site drops a setting you gave it, set it another way; add no filters of your own.
- **Deliver as you go.** Write the deliverable early and update it; mark what you have not checked.
- **Know when to stop.** After two different ways to the same thing have failed, report it
  unavailable and move on.

## Never

- Never solve or evade a CAPTCHA or a block. Try the home page, the site's search, its API or
  sitemap, or another source; a person can clear a block. Report what you could not reach as
  unavailable, never as empty.
- Never type a password. A person signs in with `login`.
- Irreversible steps (submit, pay, send, delete): confirm first unless the person already said to.
