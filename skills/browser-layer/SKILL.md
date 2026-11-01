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

## Setup (once)

```bash
command -v browser-layer || npm install -g browser-layer   # needs Node.js 22+
browser-layer browser                                      # which browser it drives
```

If it says no browser was found, run `browser-layer install` (Linux servers: `--with-deps`).
`browser-layer help` lists every command for the installed version. Read it once per task.

## The loop

1. `browser-layer tab <url>` opens a live tab and answers with the **map**: regions, fields,
   actions, lists and links, each with a ref like `[15]`.
2. Act on a ref, or on a control's name: `click 31`, `click "Next"`, `type 15 Mumbai --enter`,
   `pick 22 "Economy"`, `check 40`.
3. Every action answers with **what changed** (`- old line` / `+ new line`), a new page's map,
   or the new records in a table. That answer is the new state. Do not re-read the page after it.
4. Go deeper only where you need to: `read <ref>` for one region in full, `find <text>` for the
   lines that mention something, `get <ref>` for a list or table as records.

## Example

```text
$ browser-layer tab shop.example.com/orders
tab 1  https://shop.example.com/orders  "Orders"

[40] main
  headings: Orders
  [52] table of 30: columns Order · Status · Total
  actions: [61] button "Next" · [62] button "Export CSV"

$ browser-layer get 52 --sort c3 --desc --limit 2
tab 1  https://shop.example.com/orders  "Orders"  — [52] table: 30 records, 3 columns (sorted by c3 descending, first 2)

c1 Order	c2 Status	c3 Total
ORD-17	Paid	₹9,450
ORD-04	Refunded	₹8,200

$ browser-layer click "Next"
tab 1  https://shop.example.com/orders  "Orders"  — new records in [52] table, settled: idle in 412 ms
…the next 30 orders, as records…
```

## Habits that save steps

| Do | Instead of |
| --- | --- |
| Chain known steps in one shell call: `type 7 550000 && type 8 20 && click 27` | One command per turn |
| `get <ref> --sort c2 --desc --limit 5` on a `list of N` / `table of N` from the map; add `--urls` when you need each record's link and picture addresses | Reading the whole page, or `eval` with querySelector |
| `find Python` when a menu or page is long | Scrolling through the full text |
| Open a filtered URL directly when the task allows it (`/trending/python?since=weekly`) | Clicking through filters you could put in the URL |
| `click "Next"` by name when the name is unique | `map` just to find one ref |
| `wait "Market Cap"` when content loads late | Repeating `read` until it appears |
| `net`, `net show <#>`, then `net save <#> <file>`, when the data comes from an API call | Reconstructing it from the rendered page |
| `browser-layer open <url>` for a static page that needs no JavaScript | A live tab |

## Getting all of it, and showing it is all

- A list is complete only when you can show it ended: the site's own total (`412 results`) matches
  what you collected, the last page has no Next, or `scroll` brings no new rows three times. Until
  then say how many of how many, never "all" or "none".
- Walk every page: `click "Next"` (or the page's own URL parameter, `?page=3`) until it ends, keeping
  the same page size and sort. Open the detail page when the list does not show what you need.
- The page's data usually comes from an API, with every field and often the total count. `net` lists
  the calls, `net show <#>` previews one (request, response, the first part of the body), and
  `net save <#> data.json` writes the whole answer to a file: read it with `jq` or a script, not by
  printing it. For the next page or other filters, call the same API from the page, which sends the
  site's own cookies: `browser-layer eval "await (await fetch('/api/search?page=2')).json()" > p2.json`.
  A site's `robots.txt` and `sitemap.xml` list pages its menus do not.
- A big result belongs in a file, not in your context: `get <ref> --out ads.tsv`, `find "ID:" --out ids.txt`
  or `read --out page.txt` write it whole, then work on the file with `grep`, `jq` or a script. Read
  pages (`--page 2`) only for what you need to look at. Save what you have collected as you go, so a
  task that runs out of time still leaves a result.
- After typing into a filter or search, check the answer: the results, their count or the URL should
  change. A suggestion list needs a pick before the filter applies.
- Keep to what the task asks for: its site, query, filters and dates; add none of your own. When the
  site drops or changes one (a redirect to another view, a filter that does not stick), set the same
  thing another way, through the page's own controls or the URL as the site itself writes it, and
  check that it took.

Refs stay valid on the same page; after a new page loads, use the refs from its map. A name that
matches more than one control is an error that lists the refs: pick one.

## Answers you will see

- `— 2 lines gone, 5 new` — the action worked; those lines are what changed.
- `— new records in [12] table` — the next page of a table; the records follow.
- `+ [1022] menu of 847: …` — a long list, shown as one line. `find <text>` or `read 1022` goes in.
- `blocked: …` — the site refused this browser or shows a CAPTCHA. Never solve or evade the check,
  but do not give up on the first wall either: a block often covers one page, not the site. Try the
  normal ways in, in turn: the same page after a short wait; the site's home page, then its own search
  or menus; another URL for the same content (a category page, another region of the site); the
  site's API (`net`) or `browser-layer open <url>`; its sitemap; an archived copy; another source with
  the same facts. When a search engine is walled, go to the site directly. If it stays blocked, tell
  the person: they can run `browser-layer show`, clear it in that window, then `browser-layer hide`.
  Report what you could not reach as unavailable, never as empty.
- `covered by <div> "…"` — a banner or pop-up is over the control. Close it with its own button
  (Accept, Close, ×) or `press Escape`, then act again.
- `the page did not answer in 75 s` — the page is stuck. `close` it and open it again; other tabs
  keep working.
- A page whose content is pictures (a scanned book, a map, a video) or that asks you to turn off an
  ad blocker: `browser-layer allow images`, then `reload`.
- `settled: deadline 5000 ms (the page kept changing)` — the page is still busy; `wait <text>`
  for what you need.

## When a person is involved

- **Sign-in:** never type passwords. Ask the person to run `browser-layer login <url>`, sign in
  in the window that opens, and close it. The agent's browser is signed in from then on.
- **Watching:** `browser-layer show` makes the browser a visible window; `hide` makes it headless.
- **Pictures:** `browser-layer screenshot [ref] [file] [--full]` saves a PNG of the tab, one
  region (`screenshot 160 list.png`), or the whole page, when a person asks for one. Images and
  fonts are not loaded unless `allow images` was given for the site, so they are missing from it.
- **Irreversible steps** (submit an application, pay, send, delete): stop and confirm with the
  person first unless they already said to do it.

## Several agents at once

Give each its own session so their tabs do not collide: `--session <name>` or
`BROWSER_LAYER_SESSION=<name>`. Cookies are shared between sessions; `--profile <name>` is a
separate browser with its own cookies.

## Done

`browser-layer stop` closes the browser when the task is over. It also stops by itself after 30
idle minutes.
