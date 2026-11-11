import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// An agent reads one document, the skill or `help`, whichever its host gives it first; they must say the same.
test('the skill body is exactly what `browser-layer help` prints', () => {
  const help = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'help'], { encoding: 'utf8' })
  const skill = readFileSync('skills/browser-layer/SKILL.md', 'utf8').split('\n---\n')[1]
  assert.equal(skill.trim(), help.trim())
})
