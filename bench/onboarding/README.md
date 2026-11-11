# Onboarding exam

How well does a model write browser-layer commands when all it has learned the tool from is a given
onboarding text? No browser is needed: each call is one headless `claude -p` turn, no tools, a variant's
text as the system prompt, one scenario as the question, the shell commands as the answer.

```bash
node bench/onboarding/run.mjs --out /tmp/exam --models haiku,sonnet --repeats 3 --max-usd 2
node bench/onboarding/report.mjs /tmp/exam            # --detail lists more of what was missed
node bench/onboarding/overlap.mjs                     # which facts skill and help each carry
node bench/onboarding/run.mjs --out /tmp/exam --variants manual --repeats 5 --models haiku   # the full manual first,
node bench/onboarding/ablate.mjs run --out /tmp/exam  # then each unit removed in turn, only on the scenarios that test it
node bench/onboarding/ablate.mjs report /tmp/exam     # ranked by what removing the unit cost
```

`--variants` takes names separated by `;`. Besides the names in `variants.json`, `cut:4-4,16-17` is manual v1 without
those lines, and `head:40` is the first 40 lines of the current help: what `browser-layer --help | head -40` shows, which
is what a model with no skill ran first when only the tool's name was given (haiku and sonnet both).

- `scenarios.json`: 39 plain-language scenarios (7 from real errors in the Codex transcripts: a stale ref, `get` on a list with no rows, `pick` on a custom dropdown; and the rules a loss would not show elsewhere: lists complete, a dropped filter, deliver early, stop after two failures). Each has `must` checks (a verb, a flag, a rule, tagged) and `not`
  checks (a shell loop, curl, typing a password, clicking a delete button). `scope: "text"` checks the prose.
- `variants.json`: what each variant gives the model. `skill` and `help` follow the repo (`help` is read from
  `src/cli.ts`); files under `variants/` are fixed texts. `baseline` is the onboarding before the change that made help
  the whole manual (`old-skill.md`, `old-help.txt`); `current` is whatever the repo has now.
- `grade.mjs`: parses every `browser-layer` call (inside `steps '…'` too) against the vocabulary of help, and counts
  verbs and flags that do not exist as *invented*. `report.mjs` prints the score (share of checks met), scenarios passed
  in full, invented commands, the checks missed most, and the onboarding size at step 1 in characters and tokens
  (characters / 4) and carried over 72 steps.
- Answers are kept under `--out`; a call that has an answer is not repeated, and grading never calls a model, so a
  grader fix is a re-run of `report.mjs`.

`--models` goes to `claude --model` unchanged. **Only Claude models (haiku, sonnet) were reachable here; results for
other model families are unknown.** The exam tests whether the text carries the facts and rules, not whether a
model navigates a real page; `bench/local` (the agent harness) does that.

Costs seen: haiku about $0.0005 a call, sonnet about $0.0065 (one variant, 32 scenarios, 3 repeats: $0.05 and $0.6).
The grader is regex-based: it accepts equivalent valid commands (`hover` chains for a menu, `open` or `each` for many pages,
a verb written without `browser-layer`, comment lines ignored) and fails invented verbs and flags. Read scores as comparisons
between variants, not as absolutes. `menu` was "never used" only because the grader wanted `menu "A > B"`: with `hover` accepted,
and the line saying what it replaces, haiku and sonnet use it. Wording tuned against the exam (the `menu` line) inflates a
variant's own score; keep scenarios out of the texts.

Variants worth knowing: `baseline` (skill + help before the one-document change), `manual` (manual v1, the text of 315f918),
`trimmed` (v1 minus what the ablation found free; tried on long tasks and reverted), `final` (the repo's help, Rules first).
Real runs: `node bench/local/run.mjs --out DIR --arm base=315f918 --arm new=HEAD --repeats 3 --model haiku` (short set) and the same
with `--set long --tasks long-quotes-century,long-books-stock --repeats 6` from `claude/long-tasks-582bea`'s harness; run under `caffeinate -dims`.
