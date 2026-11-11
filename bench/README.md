# bench/local — a cheap test of a change on real agent behaviour

Runs headless Claude Code (`claude -p`, Bash and Skill only, haiku, 40 turns, 8 minutes) on seven fixed
public-site tasks (`bench/local/tasks.json`) with a git ref of browser-layer, and compares two builds. Costs Claude
tokens only: about $0.004 a run, so 70 runs are about $0.30. No logins; the form task sends made-up values to
httpbin's echo page; runs go three at a time, about one per site.

```sh
node bench/local/run.mjs --out bench/local/out/x --arm A=hardening --arm B=my-branch --repeats 5
node bench/local/compare.mjs --a A --b B bench/local/out/x
```

- A build is `npm pack`ed from the ref into its own prefix (cached in the temp directory per commit); each run has its
  own `BROWSER_LAYER_HOME`, temp directory, and a project skill from that ref.
- `--arm B=ref,skill=filler` appends 14,000 characters of DESIGN.md to the skill; `,skill=<ref>` takes the skill from another ref.
- Estimate is printed first; `--max-usd` (5) stops it. A finished run is never repeated, so rerun to resume, or add arms
  to the same `--out` directory.
- Compare an arm with another directory's arm by passing both directories (the A/B reuses A/A's control).
- Tasks' answers were computed from the pages once (`expect`: tokens that must appear after "Answer:"; score is the share found).

## Metrics (per run, from the transcript)

| metric | meaning |
|---|---|
| score | share of expected tokens in the answer |
| steps | Bash calls |
| lookbacks | calls that are rg, grep, sed, head, awk, jq, python and the like (a shell command, not browser-layer; counts a `browser-layer … \| head` as browser-layer) |
| chars | characters the calls returned |
| carried | each output's size times the calls after it (`bench/carried.mjs`) |
| inputTokens / outputTokens | from the stream's usage (input includes cache reads and writes) |
| usd, wallS | as reported by Claude Code; seconds |
| limit | `turns`, `time` or `no-result` when a run did not finish |

## Reading the noise floor

`compare.mjs` pairs by task and prints the mean difference B − A, its standard error across tasks, the count of tasks
going each way, the rep-to-rep spread inside a task, and `detectable %`: twice the standard error as a share of A's mean.
A difference smaller than that is not evidence. Run an A/A (same ref under two labels) whenever the task set, model or
repeat count changes, and read its table as the floor. A difference is worth believing when it exceeds the floor and most
tasks go the same way.

## What it is not

The agent is Claude haiku, not the benchmark's Codex, and the tasks are short (about 4 steps, no run hit a limit), so
numbers show the direction of agent behaviour, not benchmark scores. It cannot show the long-task effects (timeouts, 100-step
runs, blocked sites).

## Calibration (11 Nov 2026, haiku, 7 tasks × 5 repeats per arm)

A/A, `hardening` against itself (70 runs, $0.27); the last column is the smallest difference that clears 2 standard errors:

| metric | A1 | A2 | diff | detectable |
|---|---|---|---|---|
| input tokens | 94,406 | 93,186 | -1.3% | 6% |
| usd | 0.0040 | 0.0038 | -5% | 4% |
| wall seconds | 19.3 | 19.5 | +1% | 8% |
| steps | 4.46 | 4.43 | -0.6% | 9% |
| score | 1.00 | 0.94 | -0.06 | 7% |
| output tokens | 1,617 | 1,684 | +4% | 9% |
| chars returned | 8,682 | 7,966 | -8% | 18% |
| carried | 11,793 | 11,299 | -4% | 24% |
| look-backs | 0.37 | 0.26 | -0.11 | 52% |

Stable enough to trust: input tokens, cost, wall time, steps, score. Weak: characters returned and carried (a few large answers
dominate, within-task spread 40-60%). Not usable: look-backs (about 0.3 a run on these short tasks).

A/B, `hardening` against the same build with 14,000 characters of filler appended to the skill (35 more runs, $0.18, control reused from the A/A):
input tokens +31% (7 of 7 tasks up), cost +28% (7/7), wall time +43% (7/7), look-backs +0.37 (5/0, about 2 standard errors);
steps, carried, chars and score unchanged. So it sees a token-cost effect of this size at once and a behaviour (steps) effect
only if it exceeds about 10%; a smaller change in steps or carried characters is below the floor.

## Long tasks (`--set long`)

Six tasks marked `"long": true` in `tasks.json`: 150 turns and 12 minutes (a run silent for 4 minutes is killed and rerun, twice at
most). Expected answers come from `bench/local/long-expect.mjs`, which reads the pages over plain HTTP, so they do not depend on the date.

```sh
caffeinate -dims node bench/local/run.mjs --out bench/local/out/long --arm A=hardening --arm B=my-branch --set long --repeats 3
```

Run it under `caffeinate`: a sleeping Mac suspends the runs and they end at the time limit with no result (check `pmset -g log`
for a sleep gap and discard runs that overlapped one). Cost: haiku, about $0.011 a run, so 36 runs (two arms, 3 repeats) are $0.40
and 18 more for a third arm $0.18. Sonnet used fewer steps (2-10 against 8-15 on three tasks) at 5-10 times the cost, so haiku is the model.

What the tasks do (haiku, A/A means over 6 runs): quotes-pairs 9 steps, quotes-century 11, books-stock 16, books-categories 16,
internet-b 21, internet-a 31; mean 17, none near the 30-100 of the real benchmark. Tasks that fetch many pages with one `open --out`
or `each` call stay short, so more pages do not make a task longer; separate interactive lookups do. Tasks under 10 steps (hockey,
Oscars, RFC counts, ten book lookups, the author/tag form) were dropped.

### Calibration (11 Nov 2026, haiku, 6 tasks × 3 repeats per arm)

A/A, `hardening` against itself (36 runs, $0.40); detectable is twice the standard error as a share of A's mean:

| metric | A1 | A2 | diff | detectable |
|---|---|---|---|---|
| steps | 16.6 | 18.2 | +10% | 20% |
| input tokens | 331k | 382k | +15% | 22% |
| usd | 0.0104 | 0.0116 | +11% | 12% |
| wall seconds | 97 | 119 | +23% | 15% |
| score | 0.98 | 0.94 | -0.05 | 12% |
| output tokens | 6,574 | 7,708 | +17% | 15% |
| chars returned | 15,224 | 15,635 | +3% | 16% |
| carried | 123k | 153k | +24% | 29% |
| look-backs | 1.56 | 1.61 | +0.06 | 45% |

Trustworthy for long tasks: cost (12%), score, wall time and output tokens (15%), characters returned (16%). Steps (20%), input
tokens (22%) and carried (29%) only for large effects; look-backs not at all. Wall time ran 23% higher in A2 although its
detectable level says 15%: rep-to-rep spread is 20-27% inside a task, so three repeats are few.

### Does it see a known difference? No.

`hardening` (A1) against the same build with the `--out` preview removed (commit `2c5e4fd`'s `saved()` change reverted; 18 runs, $0.18):
steps 16.6 → 16.0 (-3%, 3 tasks up, 3 down, detectable 27%), look-backs 1.56 → 0.44 (0/2 tasks; the wrong way and not significant),
carried -7% (detectable 44%), cost -5% (27%), score equal. The preview was measured at -22% steps on the 15-100 step benchmark tasks.
These tasks mostly read pages with `open --out` and then run one script, or use `get` and `eval`, so a preview of the saved file
rarely saves them a read; the harness shows nothing because the effect is not there on them, or is below 27% with 3 repeats.
Do not use the long set to accept or reject a change to what a saved answer contains.

## Pre-release gate (`gate.mjs`)

```sh
node bench/local/gate.mjs <candidate-ref> <baseline-ref> [--repeats 3] [--max-usd 2]
```

Runs the short and the long set for both refs (haiku, under `caffeinate -dims`, into `bench/local/out/gate-<shas>`; a rerun
resumes), drops runs that started or ran within a minute of a `pmset` sleep event (delete them and rerun to refill), pairs by task
over all 13 tasks, and prints one table and `GO` or `NO-GO` (exit 0 or 1). The rule is `bu-run/finalcompare.py`'s: the mean per-task
difference with a 95% bootstrap interval (10,000 resamples of tasks), AHEAD only when the whole interval is on the candidate's
side, BEHIND when it is wholly on the other side, else tie. NO-GO when cost, wall time or score is BEHIND, or the mean score is
lower at all. `node --test bench/local/gate.test.mjs` checks that logic on fixed numbers.

Cost per full run at 3 repeats: 13 tasks × 2 refs × 3 = 78 runs, about $0.6 (short $0.17, long $0.40) and 25-30 minutes.

What it can judge, from the two A/A tables above: cost, wall time and score (chance differences of 4-12%, 8-15%) and output tokens;
a candidate that is genuinely 15% cheaper or slower shows. It lists steps and input tokens (20-22% on the long set, 9% and 6% on
the short) but they never veto, and an A/A of one repeat shows them AHEAD by chance. It cannot judge a change to what a saved
answer holds (the `--out` preview revert moved steps -3%), look-backs, carried characters, or anything the real benchmark's 50-150
step tasks are needed for. The score rule is strict on purpose: an A/A can lower the mean score by 0.05 by chance, and then a
rerun is the answer. The agent is Claude haiku, so a GO is not a benchmark score.
