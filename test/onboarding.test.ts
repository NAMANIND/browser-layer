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

// Haiku refused 5 of 5 logins whose username and password were in the task, because help said never to type passwords.
test('help lets an agent type a password the user gave in the task', () => {
  const help = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'help'], { encoding: 'utf8' })
  assert.match(help, /Sign-in:[^\n]*the user gave/)
})

// A judge reads the final answer: a derived value shown without its inputs cannot be checked (BU Bench bu2-153).
test('help asks for the source numbers and arithmetic behind a derived value', () => {
  const help = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'help'], { encoding: 'utf8' })
  assert.match(help, /derived[^\n]*arithmetic/)
})
