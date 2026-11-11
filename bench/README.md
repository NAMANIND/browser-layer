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
