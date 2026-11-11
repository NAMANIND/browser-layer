# Onboarding exam

How well does a model write browser-layer commands when all it has learned the tool from is a given
onboarding text? No browser is needed: each call is one headless `claude -p` turn, no tools, a variant's
text as the system prompt, one scenario as the question, the shell commands as the answer.

```bash
node bench/onboarding/run.mjs --out /tmp/exam --models haiku,sonnet --repeats 3 --max-usd 2
node bench/onboarding/report.mjs /tmp/exam            # --detail lists more of what was missed
node bench/onboarding/overlap.mjs                     # which facts skill and help each carry
```

- `scenarios.json`: 32 plain-language scenarios. Each has `must` checks (a verb, a flag, a rule, tagged) and `not`
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
The grader is regex-based and strict (for example `menu "A > B"` is required where `hover` would also work), so read
scores as comparisons between variants, not as absolutes. Wording tuned against the exam (the `menu` line) inflates a
variant's own score; keep scenarios out of the texts.
