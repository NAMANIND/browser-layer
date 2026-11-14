# browser-layer (agent-fixes eeb6f5b) against Browser Use 1.0 CLI on bu2-162, 163, 168, 178, 179

A = browser-layer built from a clean `git archive` of `eeb6f5b` (image `bu-agent:long6`; `browser-layer help` and `SKILL.md` inside the image have the same md5 as the repo's: help c8665289…, SKILL 32c9281f…).
B = Browser Use 1.0 CLI (`bu-agent:bu1cli`, unchanged). Same Codex gpt-6-luna (medium) through the key proxy, same judge (gpt-5.6-luna xhigh), same prompt and `--outputs`,
one container per task, five at once, 30 min limit. Two runs of each arm, alternated A1, B1, A2, B2, each run about 30 minutes: 13 Nov 23:58 to 14 Nov 02:04 (this Mac's clock),
so all four ran in one two-hour night window. No earlier run (12 Nov, e5b7f90) is used as a baseline.
Files: `A1/ A2/ B1/ B2/` (+ logs, `judge_usage.jsonl`), `orchestrate6.py` (stock harness plus judge-usage logging), `run.sh`, `chain.sh`, `report_data.py` (all counts below), `cost.py`.

## Verdict
**One thing holds in both runs of A against both runs of B: A uses more tokens, steps and money (and minutes) over the five tasks.** On score, no overall claim holds: A's two runs are 0.59 and 0.24, B's are 0.32 and 0.32, so A is above B in one run and below in the other.
Per task, only **bu2-178** is a score difference seen in every pairing (A 0.78 and 0.62, B 0.42 and 0.44), and it is also where A's extra tokens are clearest. Nothing else is a win or a loss.

## Money (ceiling $5)
Agent spend from the proxy's counts at gpt-6-luna list price: A1 $0.73, A2 $0.56, B1 $0.47, B2 $0.48 = **$2.24**. Proxy caps ($2.00 per A run, $1.00 per B run) were never reached: no refused calls, no run cut by the cap.
Judge, logged this time from the response usage of all 20 calls: 1,716,861 prompt tokens (none cached) and 565,751 completion tokens (about 28k per call, mostly reasoning); per run $0.137, $0.116, $0.110, $0.092.
**The judge's price is not in the repo**, so I costed those tokens at gpt-6-luna list price: **$0.455** (an assumption). Total under that assumption **$2.69**. The tokens are exact; if the judge's real output price is much above $0.50 per million,
the total moves (the 566k completion tokens dominate: at $2 per million they would cost $1.13, total about $3.5; at $5 per million $2.83, total about $5.2). Check the OpenAI usage page for the true figure. The running total never neared $4 under the assumed price.

## Per task: score / steps / input tokens / minutes / agent cost
| task | A1 | A2 | B1 | B2 |
|---|---|---|---|---|
| bu2-162 | 0.54 / 93 / 5.86M / 10.1 / $0.092 | 0.04 / 97 / 4.45M / 19.1 / $0.068 | 0.30 / 138 / 9.55M / 14.3 / $0.136 | 0.48 / 58 / 1.53M / 5.3 / $0.027 |
| bu2-163 | 0.62 / 188 / 17.12M / 30.0 / $0.283 TIMEOUT | 0.00 / 124 / 11.70M / 30.0 / $0.169 TIMEOUT | 0.00 / 112 / 11.72M / 30.0 / $0.166 TIMEOUT | 0.52 / 122 / 13.18M / 25.3 / $0.203 |
| bu2-168 | 0.28 / 60 / 1.77M / 4.6 / $0.028 | 0.14 / 50 / 1.44M / 7.7 / $0.025 | 0.45 / 54 / 2.00M / 5.9 / $0.035 | 0.14 / 43 / 1.17M / 4.9 / $0.024 |
| bu2-178 | 0.78 / 159 / 13.71M / 18.0 / $0.166 | 0.62 / 164 / 13.40M / 23.0 / $0.158 | 0.42 / 51 / 2.76M / 9.0 / $0.051 | 0.44 / 39 / 1.27M / 8.6 / $0.028 |
| bu2-179 | 0.75 / 125 / 11.45M / 17.6 / $0.158 | 0.38 / 107 / 8.40M / 27.1 / $0.138 | 0.41 / 79 / 4.70M / 9.4 / $0.079 | 0.00 / 128 / 14.78M / 30.0 / $0.201 TIMEOUT |
| **mean score / steps / input / minutes / cost** | 0.59 / 625 / 49.9M / 80 / $0.73 | 0.24 / 542 / 39.4M / 107 / $0.56 | 0.32 / 434 / 30.7M / 69 / $0.47 | 0.32 / 390 / 31.9M / 74 / $0.48 |

Mean score per arm over its two runs: A 0.41, B 0.32. Timeouts (30 min, no `FINAL ANSWER:`): A1-163, A2-163, B1-163, B2-179. A1-163 still scored 0.62 because its JSON file was already saved; A2-163 and B1-163 scored 0.00 (nothing delivered).
The same task and arm swings by up to 0.5 between runs (A on 162: 0.54 / 0.04; A on 179: 0.75 / 0.38; B on 163: 0.00 / 0.52; B on 179: 0.41 / 0.00).

## Counts from the transcripts (sum over the five tasks)
Counted per shell command (a command that chains several calls counts once), from `events.jsonl` by `report_data.py`. Own shell commands = sed, rg, awk, node, cat, jq, grep, python, head, tail, sort, wc, cut, uniq at command position, with
heredoc bodies and quoted strings removed (so the code inside B's `browser-use <<'PY'` scripts is not counted). The new verbs do not exist in B (0 by construction).
| | A1 | A2 | B1 | B2 |
|---|---|---|---|---|
| commands run | 562 | 492 | 366 | 319 |
| model requests (proxy) | 597 | 538 | 407 | 366 |
| input tokens per request (average) | 83K | 73K | 75K | 87K |
| `find --in` | 13 | 28 | n/a | n/a |
| `read --lines` | 21 | 22 | n/a | n/a |
| `get <file>` (any) / with `--where` | 20 / 20 | 20 / 19 | n/a | n/a |
| `get <ref> --where` (a page list) | 2 | 4 | n/a | n/a |
| `each --from` | 2 | 0 | n/a | n/a |
| `status` | 6 | 4 | n/a | n/a |
| `eval` | 14 | 3 | n/a | n/a |
| `get --all` calls | 28 | 12 | n/a | n/a |
| … `ended` | 1 | 0 | | |
| … `all this page shows` | 11 | 6 | | |
| … `not shown to be complete` | 15 | 3 | | |
| … `stopped` | 0 | 0 | | |
| browser-layer errors (reply starts `error:`) | 35 | 38 | n/a | n/a |
| commands with non-zero exit | 40 | 49 | 26 | 20 |
| agent's own shell commands | 32 | 3 | 15 | 52 |
| characters those returned | 941,087 | 2,787 | 147,085 | 454,750 |
| command outputs over 8,000 characters | 46 | 34 | 50 | 53 |

(The remaining `get --all` calls, 1 in A1 and 3 in A2, answered with an error or no ending text.)
- The new verbs are used: `find --in` 41, `read --lines` 43 and `get <file> --where` 39 times across the two A runs, in place of most of the old sed/rg/awk reading. In A2 the agent ran only 3 shell commands (2.8k characters); in A1, 32 commands and 941k characters,
  of which 705k was one command on bu2-162 (`browser-layer net save …` followed by `rg -n -C 3` over the saved API pages) and 235k was on bu2-163 (node scripts printing record dumps). So the shell reading dropped in one run of two. B's own shell use is 15 and 52 commands.
- `get --all` still said `not shown to be complete` 15 and 3 times and never `stopped`. On bu2-163 these are the DEP report pagers; the `--where` and `get <file>` verbs then let the agent filter the saved pages instead of reading them.
- Context per request is the same size in all four runs (73K to 87K). The difference in tokens between the arms is therefore the number of requests (A 597 and 538, B 407 and 366), not the size of what each step returns.

## Tasks where A spends more tokens than B, and why
Averaged over both runs: bu2-178 (A 13.6M, B 2.0M) and bu2-163 (A 14.4M, B 12.5M). On bu2-162 (A 5.2M, B 5.5M), bu2-168 (1.6M, 1.6M) and bu2-179 (9.9M, 9.7M) there is no stable difference: the runs of one arm straddle the other (162: B1 9.55M vs B2 1.53M; 179: B1 4.70M vs B2 14.78M).
- **bu2-178: steps, and some context.** A made 166 and 167 requests against B's 55 and 35, at 82K and 80K input per request against 50K and 36K. A's commands were 60 and 79 `click`, 17 and 18 `use`, 7 to 14 `tab`, 11 `screenshot` (A1), 9 to 19 `read`: it walks each municipal site one click at a time
  and every click answers with what changed (115k and 175k characters of click replies). B did the same walk in 35 and 24 `browser-use` script calls, each doing several navigations and extractions at once. None of A's new verbs applies here (0 to 3 `get` calls, no saved lists). The cost is the per-click round trips of the declarative interface, not reading.
- **bu2-163: more requests in A1, same in A2, and the same ceiling in both arms.** A1 177 requests at 96K, A2 121 at 96K; B1 110 at 106K, B2 110 at 119K. A1 spent its extra on 42 `get`, 16 `node` and 20 own shell commands (235k characters returned) and hit the time limit; A2 used 30 `get`, 11 `find`, 0 own shell commands and also hit it. Both arms run this task to the 30-minute limit
  (A1, A2 and B1 timed out; B2 finished at 25 minutes): it is a task where all four runs spend 11M to 17M tokens, and only the one run of A that had saved its JSON early (A1) or B that finished (B2) scored.
- bu2-179 (not a stable difference): A1 116 requests at 98K, A2 105 at 80K; B1 65 at 72K, B2 134 at 110K. B2 spent more than either A run and timed out with 0.00.

## Tasks where A scored below B in a run (one line each, from the transcripts and judge items)
- **bu2-162 A2 (0.04):** the model and the site. The site's filtered total had changed to 107 from 108, the agent got the whole list through the API, but its final answer was a long table that the run delivered cut off mid-row with no `FINAL ANSWER:` line, so the judged answer was empty. A1 on the same page got 0.54 (106 rows through a different page).
- **bu2-163 A2 (0.00):** the model. It kept researching to the 30-minute limit and never saved the JSON (A1 saved it and got 0.62). B1 did the same and also got 0.00.
- **bu2-168 A2 (0.14), A1 (0.28):** the site. Apple's old M3 order page redirects to the current lineup in every run, so the upgrade-price items fail for all four runs (B 0.45 and 0.14).
- **bu2-179 A2 (0.38 against B1 0.41):** no difference beyond noise (B2 got 0.00 after a timeout).

## What this can and cannot show
Can show: with two runs per arm, A costs more than B on this task set (steps 625 and 542 against 434 and 390; tokens 49.9M and 39.4M against 30.7M and 31.9M; cost $0.73 and $0.56 against $0.47 and $0.48; minutes 80 and 107 against 69 and 74), because it
makes more model requests at about the same context per request; and the new verbs are picked up (`find --in`, `read --lines`, `get <file> --where` 123 uses in total), cutting the agent's own shell reading to near zero in one of the two runs.
Cannot show: any score difference except possibly bu2-178. A's overall mean differs by 0.35 between its two runs, B's runs are equal only by accident (per task they move by up to 0.5), a timeout turns a task from 0.6 to 0.0, and one task (bu2-163) timed out in three of four runs.
No claim that A or B is better on accuracy; the judge's own spread (one run per task) is not measured. The judge cost uses an assumed price. Both arms ran within the same two-hour night window, which removes day-to-day drift between arms but not between the two runs of one arm, and the site changed once during the window (bu2-162: 108 to 107).

## Left running
Nothing of this run: no containers (checked), and the four proxies (ports 8821 to 8824) were stopped by the orchestrator at the end of each run. The `keyproxy.mjs` on port 8790 (not started by this session) was not touched and is still running.
