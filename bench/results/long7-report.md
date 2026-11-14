# bu2-163 on browser-layer dfa9fea: one run, against long6 A1 and A2 on the same task

Build: clean `git archive` of `dfa9fea` (image `bu-agent:long7`). `SKILL.md` in the image has the same md5 as the repo's (32c9281f…); the `browser-layer help` md5 is c8665289…, the same as long6's (the diff `eeb6f5b`..`dfa9fea` touches no help text), and the image's `dist/reader.js` contains the `tabindex` change.
Same harness as long6 (`orchestrate6.py`, Codex gpt-6-luna medium through the key proxy, judge gpt-5.6-luna xhigh, `--outputs`, 30 min limit), arm A only, task bu2-163 only, one run, proxy cap $2.00 on port 8825. Run on 14 Nov, 16:10 to 16:34 (this Mac's clock), about 14 hours after long6's runs.
Baseline is long6 A1 and A2 on bu2-163 only (no other run). Files: `A1/` (run), `A1.log`, `run.sh`, `report_data.py` and `orchestrate6.py` (copies of long6's).

## Result (one run: no overall claim)
| | long6 A1 | long6 A2 | long7 (dfa9fea) |
|---|---|---|---|
| score | 0.62 | 0.00 | 0.72 |
| timed out (30 min) | yes (JSON already saved, judged) | yes (no JSON, 0.00) | **no, finished in 23.8 min** |
| model requests | 177 | 121 | 110 |
| input tokens | 17.12M | 11.70M | 9.37M |
| input per request | 97K | 97K | 85K |
| minutes | 30.0 | 30.0 | 23.8 |
| agent cost | $0.283 | $0.169 | $0.140 |
| commands | 171 | 113 | 106 |

Judge for long7: 1 call, 83,077 prompt and 55,250 completion tokens, $0.036 at gpt-6-luna list price (assumed price; tokens exact). Total for this run about $0.18. The proxy refused no call.

## get --all on the SSRS report pages (cedatareporting.pa.gov)
Counted per `get --all` result block from `events.jsonl` (a command that chains several calls counts each), taking a block as an SSRS page when its table header carries the report's `· Unsorted` column marks. Calls of other verbs that print a progress line are not counted.
| ending text | long6 A1 | long6 A2 | long7 |
|---|---|---|---|
| `ended` | 1 | 0 | **4** |
| `all this page shows` | 3 | 0 | 1 |
| `not shown to be complete` ("Next Page" was pressed and nothing new came) | 15 | 3 | **0** |
| `stopped` | 0 | 0 | 0 |
| SSRS `get --all` calls | 19 | 3 | 5 |

Where long7's calls ended:
- `ended: no "Next Page" on the last page`, four times, each over a whole report in one call: 163 records (applications with comment period, current), 90 (same, June), 65 (without comment period), 174 (final actions, June). Each saved to a TSV.
- `all this page shows`, once: a re-read of the final-actions table with `--limit 2` after the full 174 rows were saved, which showed 14 records of the last page.

In long6 A1 the same reports took 5 to 6 calls each (pages of 29, 34, 34, 34, 47, 14 records), nearly all ending `not shown to be complete`, and the agent saved each page to its own file and re-read; the long6 A2 agent got 29 to 30 records per call, all three ending `not shown to be complete`. Counted on all `get --all` calls (not only SSRS): long6 A1 26, A2 10, long7 12.

## Other counts from the transcript (bu2-163 only)
| | long6 A1 | long6 A2 | long7 |
|---|---|---|---|
| `find --in` | 3 | 22 | 4 |
| `read --lines` | 11 | 11 | 13 |
| `get <file>` (any) | 17 | 20 | 11 |
| `get <file> --where` | 20 | 19 | 9 |
| `status` | 4 | 0 | 0 |
| `each --from` | 0 | 0 | 0 |
| browser-layer errors | 9 | 4 | 4 |
| agent's own shell commands | 20 | 1 | 6 |
| characters those returned | 235,034 | 18 | 1,535 |
| commands with non-zero exit | 7 | 3 | 9 |
| command outputs over 8,000 characters | 24 | 13 | 14 |

## Why the score is 0.72 and not higher (judge items, from `judge_response.json`)
Met: dataset shape, application-stage coverage, final-action coverage, row fidelity, window/order/dedup, coverage honesty, signal labeling (7 of 10). Violated:
- **A4 Bulletin coverage:** the agent opened the lead page and the `a` continuation for each of the two Bulletin issues (833, 799) but not their `b`/`c` pages. The agent's own choice, not a tool limit.
- **A6 exclusion compliance:** amendments and final actions were kept with no source-quoted driver (special conditions, limits, upgrade, contaminant) in their evidence; the judge lists 8 application-stage and about 20 final-action permit numbers.
- **A8 source links:** one alert (PAD160010) cites only the applications report though the record also appears in the Bulletin.
None of the three is a reading or paging failure of the tool.

## What this can and cannot show
Can show: on this run the SSRS pager ended with `ended` four times and never with `not shown to be complete`; long6 A1 had `ended` on 1 of 19 SSRS calls and A2 on 0 of 3, and their `not shown to be complete` text is the one the `get --all` change in `dfa9fea` was made for. This run also finished inside the limit, which long6 A1 and A2 did not.
Cannot show: that the change caused the better score, tokens or time. It is one run; the same build on the same task moved between 0.62 and 0.00 across long6's two runs, and a timeout alone decides that gap. The score gaps here are judged on the agent's own Bulletin and exclusion choices, which the change does not touch. No overall claim from one run. The judge cost uses an assumed price.

## Left running
Nothing: the container is gone (`docker ps` empty), the proxy on port 8825 was stopped by the orchestrator, and the `keyproxy.mjs` on port 8790 was not touched.
