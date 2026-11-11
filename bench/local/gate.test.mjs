// node --test bench/local/gate.test.mjs : the verdict rules on fixed numbers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { interval, judge } from './gate.mjs'

const rows = (f) => Array.from({ length: 12 }, (_, i) => {
  const base = { score: 1, usd: 0.01 + i * 0.001, wallS: 60 + i, steps: 10 + i, inputTokens: 100000 + i * 1000 }
  return { task: `t${i}`, base, cand: f(base, i) }
})
const verdicts = r => Object.fromEntries(judge(r).lines.map(l => [l.metric, l.verdict]))

test('interval of a constant difference is that difference', () => {
  assert.deepEqual(interval([2, 2, 2, 2]), [2, 2])
})
test('cheaper everywhere is AHEAD and GO', () => {
  const j = judge(rows(b => ({ ...b, usd: b.usd * 0.8, wallS: b.wallS - 5 })))
  assert.equal(j.lines.find(l => l.metric === 'usd').verdict, 'AHEAD')
  assert.equal(j.go, true)
})
test('costlier everywhere is BEHIND and NO-GO', () => {
  const j = judge(rows(b => ({ ...b, usd: b.usd * 1.2 })))
  assert.equal(verdicts(rows(b => ({ ...b, usd: b.usd * 1.2 }))).usd, 'BEHIND')
  assert.deepEqual(j.reasons, ['usd is BEHIND'])
})
test('a mixed difference is a tie and GO', () => {
  const j = judge(rows((b, i) => ({ ...b, usd: b.usd * (i % 2 ? 1.1 : 0.9) })))
  assert.equal(j.lines.find(l => l.metric === 'usd').verdict, 'tie')
  assert.equal(j.go, true)
})
test('a lower score that is only a tie is still NO-GO', () => {
  const j = judge(rows((b, i) => ({ ...b, score: i === 0 ? 0.5 : 1 })))
  assert.equal(j.lines.find(l => l.metric === 'score').verdict, 'tie')
  assert.deepEqual(j.reasons, ['score is lower'])
})
test('more steps alone does not veto', () => {
  const j = judge(rows(b => ({ ...b, steps: b.steps + 5 })))
  assert.equal(verdicts(rows(b => ({ ...b, steps: b.steps + 5 }))).steps, 'BEHIND')
  assert.equal(j.go, true)
})
