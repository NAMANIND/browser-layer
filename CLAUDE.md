# agent-layer — how code is written here

Read `docs/DESIGN.md` and `docs/PLAN.md` first. Work only on the current phase.

## Code rules

1. **Only what the phase needs.** No speculative options, flags, abstractions or "might need later" code.
   If DESIGN.md does not ask for it, it does not get written.
2. **Small and direct.** One job per function. Prefer fewer lines over clever lines. No wrappers that
   only rename something. No dead code, no commented-out code.
3. **Delete before adding.** When a phase replaces something, the old code is removed in the same change.
4. **Standards, not site cases.** No code that exists because one site behaved a certain way. Rules come
   from a spec or from `src/policy/` (DESIGN §1, §9). No magic numbers outside policy.
5. **Use the platform.** If the browser, Node or an existing dependency already does it, use that.
   New dependencies need a reason in the commit message.
6. **Comments explain why, never what.** Only where the reason is not obvious from the code.
7. **Test first, measure always.** A behavior change starts with a failing test. Changes to reading or
   loading report before/after numbers from `bench/` or `npm run measure`.
8. **Small commits**, each green, each with a message that says what changed and why.
   No Claude attribution in commits or PRs.

## Size

Baseline, 31 Oct 2026: 1,059 lines in `src/` across 8 files. Each phase states how the count moved
and why in its final commit. A phase that grows the code more than its features justify gets trimmed
before it is called done.
