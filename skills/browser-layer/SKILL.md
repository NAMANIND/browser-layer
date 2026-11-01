---
name: browser-layer
description: >-
  Browse and act on websites from the terminal with the browser-layer CLI: open pages, read them
  as a short text map, click, type, fill forms, read lists and tables as records, follow pagination,
  download files, and see the API calls a page makes. Use for any task on a website — research,
  extracting data, filling forms, testing a web app, checking a flow — instead of curl, scraping
  HTML by hand, or screenshots.
license: Apache-2.0
compatibility: Requires Node.js 22+, the browser-layer npm package, and Chrome, Edge or Chromium (browser-layer install downloads Chromium). Needs network access.
metadata:
  author: Naman Rai
  homepage: https://github.com/NAMANIND/browser-layer
allowed-tools: Bash(browser-layer:*)
---

# browser-layer

A browser for agents. A page comes back as a short text map of its regions and controls, every
action answers with what changed, and lists and tables come back as records. Read the page as
text; never ask for pixels to understand it.

Install once with `npm install -g browser-layer` (Node.js 22+); `browser-layer install` gets a
browser if none is found. `browser-layer help` lists every command.

## The loop

1. `browser-layer tab <url>` opens a live tab and answers with the **map**: regions, fields,
   actions, lists and links, each with a ref like `[15]`. Keep one tab open for each site the task uses
   and switch between them with `use <id>`: each stays as you left it, nothing reloads (`tabs` lists
   them). Move within a site with `go <url>`; `close` a tab you are done with.
2. Act on a ref or a control's name: `click 31`, `click "Next"`, `type 15 Mumbai --enter`,
   `pick 22 "Economy"`, `check 40`.
3. Every action answers with **what changed**, a new page's map, or the new records in a table.
   That answer is the new state; reading the page again answers with what changed since your last
   read.
4. Go deeper only where you need to: `read <ref>` for one region, `find <text>` for the lines that
   mention something, `get <ref>` for a list or table as records (`--urls` adds their addresses).

```text
$ browser-layer tab shop.example.com/orders
[40] main
  [52] table of 30: columns Order · Status · Total
  actions: [61] button "Next" · [62] button "Export CSV"
$ browser-layer get 52 --sort c3 --desc --limit 2
c1 Order	c2 Status	c3 Total
ORD-17	Paid	₹9,450
ORD-04	Refunded	₹8,200
```

## Habits

- Chain known steps in one call: `type 7 550000 >/dev/null && click 27`. Only the last answer
  needs reading; a failure still shows.
- Put filters in the URL when the site does (`?q=python&page=2`); `wait "<text>"` when content loads
  late; `open <url>` for a static page that needs no JavaScript.
- The data usually comes from an API: `net` lists the calls, `net show <#>` previews one,
  `net save <#> data.json` writes it whole. More pages from the same API:
  `eval "await (await fetch('/api/x?page=2')).json()" > p2.json` (the site's own cookies go along).
- A big result goes to a file, not your context: `get <ref> --out rows.tsv`, `find <text> --out
  hits.txt`, `read --out page.txt`; then `grep`, `jq` or a script.
- A list is complete only when you can show it ended: the site's total matches, the last page has
  no Next, or `scroll` brings nothing new three times. Until then say how many of how many.
- After a filter or search, check that the results, their count or the URL changed. When the site
  drops a setting you were given, set it another way (its own controls, the URL as it writes it).
  Add no filters of your own.
- **Deliver as you go.** Write the deliverable itself early and update it with each finding, so
  stopping at any moment still leaves your best result. Mark what you have not checked as
  unchecked; never fill it in.
- **Know when to stop.** When two different ways to the same thing have failed, report it as
  unavailable and move on; do not repeat the same kind of attempt.

## Answers you will see

- `blocked: …` — the site refused this browser or shows a CAPTCHA. Never solve or evade it. A block
  often covers one page: try the site's home page or search, another URL for the same content, its
  API or sitemap, or another source. If it stays blocked, a person can clear it: `browser-layer show`,
  then `hide`. Report what you could not reach as unavailable, never as empty.
- `covered by <div> "…"` — a pop-up is over the control: close it with its own button or
  `press Escape`.
- A page whose content is pictures (a scanned book, a map, a video) or that asks you to turn off an
  ad blocker: `allow images`, then `reload`.

## When a person is involved

- **Sign-in:** never type passwords. The person runs `browser-layer login <url>` and signs in there.
- **Irreversible steps** (submit, pay, send, delete): confirm first unless they already said to.
- `screenshot [ref] [file] [--full]` saves a picture when a person wants one.
- Several agents at once: give each its own `--session <name>`.

`browser-layer stop` closes the browser when the task is over.
