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

browser-layer — websites as text and verbs for agents. <ref> is a number from the map, or a control's name.

Start here
  tab <url>            opens a page; the answer is its map: regions, fields, actions, lists and links, each with a ref
  click 31 · click "Next" · type 15 Mumbai --enter · pick 22 "Economy" · check 40
                       every action answers with what changed: that answer is the new state, read nothing after it
  steps '<cmd>; <cmd>; ...'   everything you already know in one call (actions answer in one line, reads and the last
                       step in full); the first error stops the rest
  read <ref> · find <text> · get <ref>   go deeper only where you need to
  --out <file>         a big result goes to a file, not to your context; then grep, jq or sed -n
  Many pages, one call, never a shell loop: open --out f <url…> (static HTML, XML sitemaps, feeds), each --out f '<read>' <url…>
                       (JavaScript pages); f has a "== <url>" line per page, then its lines
  Answers to act on:   "covered by …; its controls: …" a pop-up is over it: steps 'click "Reject all"; click 31'.
                       "note: …" something did not take. "blocked: …" see Rules.

Rules
  A list is complete only when you can show it ended: the site's total matches, the last page has no Next, or scroll
  brings nothing new three times. Until then say how many of how many.
  Put filters in the URL when the site does (?q=python&page=2); wait "<text>" when content loads late. When the site drops a
  setting you gave it, set it another way; add no filters of your own. Follow the site's links and search, not guessed URLs.
  A field with suggestions (a city, a product search): choose from the list (click the option, or press Enter) before the
  next field, in the same call: steps 'type "From" Zurich; press Enter; type "To" London; press Enter'.
  Deliver as you go: write the deliverable early, update it with each finding, mark what you have not checked.
  Know when to stop: when two different ways to the same thing have failed, report it unavailable and move on.
  blocked / CAPTCHA: never solve or evade it. A block often covers one page: try the home page, the site's search, its API or
  sitemap, or another source. A person can clear it: show, then hide. Report what you could not reach as unavailable, never empty.
  Sign-in: type a password only if the user gave it in the task; otherwise a person runs login <url>. Irreversible steps (submit, pay, send, delete): confirm first
  unless they already said to. Several agents at once: each its own --session <name>. stop closes the browser when done.

Plain HTTP, no browser:  open <url…>|<ref> [--out f] (pages fetched in parallel) · verbs · do <verb> k=v ... · --json
Live tabs (headless browser, runs the page's JS):
  tab <url…>                   open tabs (several load together; the first is current; an open page is switched to)
  go <url> · back · forward · reload · tabs · use <id> · close [id|--all] · stop
  each '<read>' <url…>         load pages together, run one read on each, one answer; its tabs close (--out <file>: a line per page)
  map                          regions, fields, actions, lists and links, with refs
  read [ref] [--page N] [--full]   the page or one region; read again: what changed
  find <text> [--page N] [--urls]   lines that contain it (--urls: each link with its address)
  get <ref> [--sort col] [--desc] [--limit N] [--cols a,b] [--urls]   a list or table as records (TSV)
  get <ref> --all --out f      every record of a list: follows its next link, Load more or scroll to the end, says how it ended
  --out <file>                 on open, read, find, get: the whole result to a file
  click · dblclick · rightclick · hover <ref>      check · uncheck <ref>      submit <ref>
  type <ref> <text> [--enter] [--keys]   pick <ref> <option>   press <key>   drag <ref> <onto ref>
  scroll [ref] [down|up|top|bottom]   upload <ref> <file...>   wait [--gone] <text>
  viewport 1440x900 | mobile | reset   the tab's layout size or a phone (touch, narrow); shown in every answer's tab line until reset; reload a page already open to apply touch
  dialog accept [text] | dismiss   explore [ref] (open menus, list them)
  menu "A > B > C"             open a hover menu path in one call (instead of hover and click one by one)
  eval <js>                    run JavaScript in the page; the result as JSON; its fetch() carries the site's cookies:
                               eval "await (await fetch('/api/x?page=2')).json()"
  net [--all] · net show <#> · net save <#> <file>   the page's requests and their bodies: the data usually comes from an API
  cookies [domain] · cookies clear [domain] · storage local|session [clear]
  allow <perm>[,perm] [lat,lon]   grant to the current site; allow images, then reload, for a page whose content is pictures
                               (a scanned book, a map) or that asks you to turn off an ad blocker
  screenshot [ref] [file] [--full]   a PNG for a person, not for you to read a page
Pop-ups open as tabs and become current; downloads are saved and reported.

show / hide: watch the browser in a window. login <url>: a person signs in; the agent stays signed in.
--session <name> (BROWSER_LAYER_SESSION): an agent's own tabs, cookies shared. --profile <name>: a separate browser.
attach: set up your own Chrome for the agent. --attach <port|auto> (BROWSER_LAYER_ATTACH): work in it, in tabs of its own; it never closes yours.
BROWSER_LAYER_BROWSER=<path> picks the browser.
install · browser · update · --version
