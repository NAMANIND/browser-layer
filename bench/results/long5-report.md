# Long tasks rerun: browser-layer `agent-fixes` (e5b7f90) on bu2-162, 163, 168, 178, 179

Run 13 Nov 2026. Same setup as the 12 Nov run (`last50-luna/REPORT.md`): Codex gpt-6-luna (medium) through the key proxy, judge gpt-5.6-luna xhigh,
`--outputs`, one container per task, five at once, 30 min timeout, same `orchestrate.py`, same prompt. Arm A image `bu-agent:long5` = `bu-agent:2` + browser-layer
0.1.4 packed (`npm pack`) from a clean `git archive` of `e5b7f90` (not the working tree; nothing was written in the repo checkout). `browser-layer help` inside the image has the
same md5 as the repo's (b411d6b0…), `SKILL.md` too (4be09fd2…). Arm B image `bu-agent:bu1cli`, unchanged. Files: `A1/`, `A2/`, `B/` (+ `.log`), `ctx/` (Dockerfile, tgz, SKILL.md),
`run.sh`, `analyze.py`, `tables.py`.

## Verdict
**Not shown to have paid off, and not shown not to.** Two runs of the new build scored 0.40 and 0.53 (mean over the five tasks); the same build differs by up to 0.88 on one task between its two runs.
That run-to-run spread is larger than any difference between builds. What does look real, because it holds in both runs and in every comparable task: **the new build uses fewer
tokens and steps than the 12 Nov build on the tasks that were not cap-cut** (input tokens -40% in run 1, -27% in run 2), and the two cap-cut tasks that were broken last time (178, 179) now finish
with real scores. It still uses about 2x the input tokens of Browser Use 1.0 CLI today, and its score is level with Browser Use's (0.40 / 0.53 vs 0.39).

## Money
Agent spend from the proxy's usage at gpt-6-luna list price: A1 $0.59 (proxy said $0.587), A2 $0.46 ($0.458), B $0.31 ($0.308) = **$1.36**. Judge: 15 calls, not recorded by the harness;
at the 12 Nov estimate of $0.01 to $0.03 per call = $0.15 to $0.45 (unproven). **Total about $1.5 to $1.8, under the $5 ceiling.** Proxy caps ($2.00, $2.00, $1.00) were never reached
(0 refused calls in all three), so **no new run was cut by the cap**. One new run, A1 bu2-179, hit the 30 min time limit (see below); it is kept and marked, since it still delivered a file that was judged.

## Per task: score / steps / input tokens / minutes / agent cost
| task | old A (12 Nov) | A1 new | A2 new | old B (12 Nov) | B new (13 Nov) |
|---|---|---|---|---|---|
| bu2-162 | 0.90 / 110 / 5.71M / 13.3 / $0.091 | 0.12 / 68 / 2.46M / 7.9 / $0.044 | 1.00 / 73 / 2.63M / 8.0 / $0.043 | 0.38 / 59 / 1.82M / 7.6 / $0.035 | 0.44 / 78 / 3.56M / 9.1 / $0.057 |
| bu2-163 | 0.62 / 174 / 15.11M / 29.5 / $0.250 | 0.62 / 149 / 11.95M / 22.8 / $0.201 | 0.58 / 141 / 13.64M / 22.7 / $0.200 | 0.26 / 61 / 3.26M / 13.3 / $0.066 | 0.26 / 62 / 3.00M / 11.5 / $0.061 |
| bu2-168 | 0.19 / 96 / 4.39M / 9.6 / $0.064 | 0.05 / 31 / 0.61M / 3.6 / $0.013 | 0.14 / 67 / 2.15M / 5.8 / $0.034 | 0.00 / 32 / 0.59M / 3.8 / $0.019 | 0.26 / 45 / 1.41M / 5.6 / $0.028 |
| bu2-178 | 0.10 / 174 / 12.42M / 19.7 / $0.148 **CAP-CUT** | 0.52 / 99 / 4.57M / 11.3 / $0.065 | 0.88 / 113 / 6.93M / 11.4 / $0.093 | 0.00 / 46 / 1.80M / 6.7 / $0.033 | 0.48 / 50 / 3.46M / 13.5 / $0.054 |
| bu2-179 | 0.11 / 110 / 8.12M / 15.5 / $0.116 **CAP-CUT** | 0.67 / 177 / 17.02M / 30.0 / $0.262 **TIMEOUT** | 0.07 / 105 / 5.86M / 11.2 / $0.086 | 0.00 / 72 / 2.39M / 6.4 / $0.042 | 0.53 / 84 / 6.79M / 21.2 / $0.106 |
| **total (score = mean)** | 0.38 / 664 / 45.7M / 88 / $0.67 | 0.40 / 524 / 36.6M / 76 / $0.59 | 0.53 / 499 / 31.2M / 59 / $0.46 | 0.13 / 270 / 9.9M / 38 / $0.20 | 0.39 / 319 / 18.2M / 61 / $0.31 |

Cap-cut: the old arm A numbers for **bu2-178 and bu2-179** (ended `[codex_error] 429`), so the old arm A totals are not clean. Old arm B was not cap-cut, but its 178 and 179 scored 0 because the
agent gave no `FINAL ANSWER:` line, which also happened to new A on 162 (run 1) and 178 (run 1).
Clean comparison on the three tasks that were not cut (162, 163, 168): mean score old A 0.57, A1 0.26, A2 0.57, old B 0.21, B new 0.32; input tokens old A 25.2M, A1 15.0M, A2 18.4M.
Old B and new B differ by 0.38 on mean score with the same build: this is the same noise, in the other arm.

## What the agent did differently (counts from `events.jsonl`, summed over the five tasks)
Counts are per shell command, so a command that chains several `get` calls counts once; "errors" are browser-layer replies that start with `error:` (±1 from a stricter reading). Script: `analyze.py`.
| | old A (12 Nov) | A1 new | A2 new |
|---|---|---|---|
| commands run | 591 | 464 | 439 |
| `get --all` | 15 | 9 | 26 |
| … ended: (`ended`) | 15 (old wording: "end of list", "no new items") | 0 | 4 |
| … `all this page shows` | 0 | 7 | 7 |
| … `not shown to be complete` | 0 | 1 | 13 |
| … `stopped` | 0 | 0 | 0 |
| `get <file>` | 0 | 0 | 8 |
| `--where` / `--count` / `--group` | 0 / 0 / 0 | 0 / 2 / 1 | 3 / 0 / 0 |
| `each --from` | 0 | 4 | 3 |
| `status` | 0 | 4 | 2 |
| browser-layer errors | 35 | 47 | 22 |
| agent's own shell commands (sed, rg, awk, node, cat, jq, head, …) | 113 | 86 | 57 |
| characters those returned | 952,916 | 1,211,399 | 467,456 |
| command outputs over 8,000 chars | 63 | 50 | 29 |

Per task (get --all / own shell commands / characters returned / outputs >8,000):
- old A: 162 (3/20/82k/8), 163 (3/62/703k/44), 168 (2/3/9k/0), 178 (0/0/0/0), 179 (7/28/159k/11)
- A1: 162 (0/9/85k/3), 163 (2/45/351k/24), 168 (0/0/0/0), 178 (0/2/0.1k/1), 179 (7/30/775k/22)
- A2: 162 (3/8/73k/5), 163 (18/36/338k/17), 168 (0/3/21k/2), 178 (0/2/0.1k/0), 179 (5/8/35k/5)
Also: `browser-layer eval` (the page-script verb) was used 30 times in old A (all 162), 32 in A1 (162: 12, 179: 20), 7 in A2 (162).
For reference, Browser Use arm (not the same verbs): old B 201 commands, 23 own shell commands, 257k chars, 35 outputs >8,000; new B 255, 31, 272k, 53.

What changed in behaviour:
- The agent does now use the new verbs when the task fits: `each --from` (7 times, all on 179: details of the listings a list links to), `get <file>` (8, only A2-179), `status` (6). `--where`, `--count`, `--group` were used 3, 2 and 1 times in total: not much.
- `get --all` now tells the truth about its end in a way the old build did not: the old build said `ended` 15 of 15 times, the new one says `all this page shows` (14) or `not shown to be complete` (14) and `ended` only
  4 times. It never said `stopped`, because no call hit the round limit.
- The agent's own shell reading fell in run 2 (57 commands, 467k chars, against 113 and 953k) but not in run 1 (86 commands, 1.21M chars, all of it bu2-179: 775k chars from sed/rg/awk over saved files and
  22 outputs over 8,000). Nearly all shell reading happens on 163 and 179 in every run, as before. So the lift is not uniform: it appears in one of two runs.
- A2-163 shows a tool limit, not a gain: `get <pager> --all` came back `not shown to be complete: "Next Page" was pressed and nothing new came` 13 times on the PA DEP report pages (SSRS, a pager
  that reloads the table). Each call returned one page (29 to 34 records), and the agent paged by hand, saving `..._page2` to `..._page7` files itself. That is the old manual cost back, now with an honest warning.
  Why "nothing new came" there was not investigated (timing after the postback, or the repeat check) and is the most useful lead for the repo.

## Tasks where the new build is not better than old A (or than B)
- **bu2-162, A1 (0.12; A2 1.00):** the model. In A1 the agent skipped the site's filtered listing, used `eval` calls against the site's API and joined the deals itself, then wrote its table as a plain
  message without the `FINAL ANSWER:` line, so the judged final answer was the "did not emit" placeholder and the transcript table (about 21 rows, no coverage statement) missed the 108-row total. Same tool, same site, A2 did it properly (108 rows).
- **bu2-163 (0.62 / 0.58 against 0.62):** a tie. The judge's missed items are row fidelity (county or municipality wrong against the SSRS row) and amendment alerts without a quoted driver: the model's data work, not the
  reading tool. Tokens fell 21% and 10% and minutes 23%; the `get --all` pager limit above is where the tool could still help.
- **bu2-168 (0.05 / 0.14 against 0.19):** the site. Apple's old M3 order page now redirects to the current M5 lineup and Google/Brave block the agent, so no run, either arm, had an archived price-bearing page; the
  judge's items on upgrade prices and the 96W adapter fail for all arms (B 0.26 and 0.00 are as low). A1 gave up after 31 steps and 0.6M tokens, which is cheap but scored lowest.
- **bu2-178, A1 (0.52; A2 0.88):** the model, partly: A1 again omitted the `FINAL ANSWER:` line and had screenshot evidence for only one of ten matrices. Both new runs beat the cap-cut 0.10 and Browser Use (0.00, 0.48).
- **bu2-179, A2 (0.07; A1 0.67):** the model. A2 reached the same Blocket and Bytbil result lists (28 and 14 results on screen) but filtered so strictly that it delivered an empty CSV and "0 qualifying listings";
  the judge's frozen facts say 11 or more exist. A1, on the same pages with `each --from` for details, delivered ten rows, but ran 177 steps and 17M tokens to the 30 min limit. Browser Use got 0.53 in 21 minutes.

## What this can and cannot show
Can show: (1) the new build can complete these long tasks without the old cap-cut failure, at 59 to 76 minutes and $0.46 to $0.59 for all five, less than old A on the same five (88 minutes, $0.67 with two cut);
(2) the agent does pick up `each --from`, `status` and the honest `get --all` endings; (3) the clean-task token cut is the same sign in both runs.
Cannot show: any score difference. n = 5 tasks, 2 runs of the new build, 1 run of Browser Use: the same build moves by 0.35 to 0.88 on a task from one run to the next (162: 0.12/1.00, 178: 0.52/0.88,
179: 0.67/0.07), and Browser Use itself moved by 0.38 on mean score against its 12 Nov run. So "better than 12 Nov" (0.38 with two cut tasks, 0.57 on the three clean ones) and "level with B" are both inside noise.
Also: the 12 Nov old A used commit `141a0ec`, which differs from `e5b7f90` in more than the long-task work (e.g. the get/each/status changes are the point, but any other commit in between counts too); the tasks ran on different
days, and sites (bu2-168's Apple page, Blocket listings, "Observed" times) change; judge cost and the two-run spread are estimates; counts come from regex over command text and may be off by a few. Timing effects
of running five containers at once on one laptop apply equally to every arm. A claim about long-task tokens needs the three clean tasks run many more times; one task (163) is where the new
build still spends 12 to 14M tokens, and the pager limit is the first thing to look at there.

## Left running
Nothing of this run: no containers, and the three proxies (ports 8811, 8812, 8813) were stopped by the orchestrator when each run ended. An unrelated `keyproxy.mjs` on port 8790 (started 5 Nov, not by this session) was left alone.
