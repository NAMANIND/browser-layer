// Leave-one-out ablation of the manual: each unit (a line or a paragraph) is removed in turn and only the
// scenarios that test it are asked again. A unit whose removal does not lower the score on its scenarios, against
// the full manual on the same scenarios, is a candidate for deletion; the characters it would save are printed.
//
//   node bench/onboarding/ablate.mjs run --out DIR [--models haiku] [--repeats 5] [--max-usd 1]
//   node bench/onboarding/ablate.mjs report DIR [--models haiku]
//
// The full manual (variant `manual`, which is manual v1) must have been asked for those scenarios in DIR first (run.mjs --variants manual).
// Units are line ranges of `browser-layer help` of variants/manual-v1.txt; `at` guards against drift.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manualV1 } from './contexts.mjs'
import { grade } from './grade.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const [mode, ...rest] = process.argv.slice(2)
const opt = (k, d) => { const i = rest.indexOf(k); return i < 0 ? d : rest[i + 1] }
const dir = opt('--out', rest[0])
const models = opt('--models', 'haiku').split(',')

// [name, first line, last line, text the first line starts with, the scenarios that need it]
const UNITS = [
  ['start: tab', 4, 4, '  tab <url>', 'paginate tabs-go-stop url-filter no-screenshot'],
  ['start: click/type + answer is state', 5, 6, '  click 31', 'popup steps-chain checks stale-ref'],
  ['start: steps', 7, 8, "  steps '", 'steps-chain suggestions popup'],
  ['start: read/find/get', 9, 9, '  read <ref> ·', 'read-region find get-flags'],
  ['start: --out', 10, 10, '  --out <file>   ', 'save-big paginate scroll'],
  ['start: many pages', 11, 12, '  Many pages', 'open-static each-js sitemap-xml'],
  ['start: answers to act on', 13, 14, '  Answers to act on', 'popup blocked stale-ref'],
  ['cmd: plain HTTP', 16, 16, 'Plain HTTP', 'do-verb open-static sitemap-xml'],
  ['cmd: tab <url…>', 18, 18, '  tab <url…>', 'tabs-go-stop'],
  ['cmd: go/back/tabs/use/close/stop', 19, 19, '  go <url>', 'tabs-go-stop'],
  ['cmd: each', 20, 20, "  each '<read>'", 'each-js'],
  ['cmd: map', 21, 21, '  map ', 'no-screenshot stale-ref'],
  ['cmd: read', 22, 22, '  read [ref]', 'read-region save-big'],
  ['cmd: find', 23, 23, '  find <text>', 'find'],
  ['cmd: get', 24, 24, '  get <ref>', 'get-flags paginate no-rows'],
  ['cmd: --out', 25, 25, '  --out <file>   ', 'save-big paginate scroll'],
  ['cmd: dblclick/rightclick/hover/check/submit', 26, 26, '  click · dblclick', 'pointer checks'],
  ['cmd: type/pick/press/drag', 27, 27, '  type <ref>', 'checks steps-chain custom-select pointer'],
  ['cmd: scroll/upload/wait', 28, 28, '  scroll [ref]', 'scroll upload wait'],
  ['cmd: dialog/explore', 29, 29, '  dialog accept', 'dialog menu'],
  ['cmd: menu', 30, 30, '  menu "A', 'menu'],
  ['cmd: eval', 31, 32, '  eval <js>', 'eval-fetch'],
  ['cmd: net', 33, 33, '  net [--all]', 'net-api eval-fetch'],
  ['cmd: cookies/storage', 34, 34, '  cookies [domain]', 'storage'],
  ['cmd: allow', 35, 36, '  allow <perm>', 'images'],
  ['cmd: screenshot', 37, 37, '  screenshot [ref]', 'screenshot-person no-screenshot'],
  ['cmd: pop-ups/downloads', 38, 38, 'Pop-ups open', 'upload pointer'],
  ['cmd: show/hide/login', 40, 40, 'show / hide', 'login blocked watch-attach'],
  ['cmd: --session/--profile', 41, 41, '--session', 'sessions'],
  ['cmd: attach', 42, 42, 'attach:', 'watch-attach'],
  ['cmd: BROWSER_LAYER_BROWSER', 43, 43, 'BROWSER_LAYER_BROWSER', 'watch-attach'],
  ['cmd: install/update', 44, 44, 'install ·', 'watch-attach'],
  ['rule: list complete', 47, 48, '  A list is complete', 'list-complete scroll paginate'],
  ['rule: filters in URL, wait, dropped setting', 49, 50, '  Put filters', 'url-filter wait dropped-filter'],
  ['rule: suggestions', 51, 52, '  A field with suggestions', 'suggestions'],
  ['rule: deliver as you go', 53, 53, '  Deliver as you go', 'deliver-early'],
  ['rule: know when to stop', 54, 54, '  Know when to stop', 'two-failed blocked'],
  ['rule: blocked / CAPTCHA', 55, 56, '  blocked / CAPTCHA', 'blocked two-failed'],
  ['rule: sign-in, irreversible, sessions', 57, 58, '  Sign-in:', 'login irreversible sessions tabs-go-stop'],
]
const lines = manualV1().split('\n')
for (const [name, a, , at] of UNITS) if (!lines[a - 1].startsWith(at)) { console.error(`the manual changed: "${name}" is not at line ${a}`); process.exit(2) }
const id = ([, a, b]) => `cut:${a}-${b}`

if (mode === 'run') {
  for (const u of UNITS) execFileSync(process.execPath, [join(here, 'run.mjs'), '--out', dir, '--models', models.join(','), '--variants', id(u), '--scenarios', u[4].split(' ').join(','),
    '--repeats', opt('--repeats', '5'), '--concurrency', '8', '--max-usd', opt('--max-usd', '1'), '--est-usd-per-call', opt('--est-usd-per-call', '0.0007')], { stdio: 'inherit' })
} else {
  const scenarios = Object.fromEntries(JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8')).map(s => [s.id, s]))
  const score = (model, variant, ids) => {
    const d = join(dir, model, variant)
    const rows = existsSync(d) ? readdirSync(d).map(f => JSON.parse(readFileSync(join(d, f), 'utf8'))).filter(r => ids.includes(r.scenario)) : []
    return { n: rows.length, mean: rows.reduce((a, r) => a + grade(scenarios[r.scenario], r.answer).score, 0) / (rows.length || 1) }
  }
  for (const model of models) {
    console.log(`\n${model}: unit\tchars saved\tfull\twithout\tchange`)
    const out = UNITS.map(u => {
      const ids = u[4].split(' ')
      const full = score(model, 'manual', ids), cutScore = score(model, id(u), ids)
      const saved = lines.slice(u[1] - 1, u[2]).join('\n').length + 1
      return { name: u[0], saved, full: full.mean, cut: cutScore.mean, n: cutScore.n, change: cutScore.mean - full.mean }
    }).sort((a, b) => a.change - b.change)
    for (const r of out) console.log(`${r.name}\t${r.saved}\t${r.full.toFixed(3)}\t${r.n ? r.cut.toFixed(3) : '-'}\t${r.n ? (r.change >= 0 ? '+' : '') + r.change.toFixed(3) : 'not run'}`)
  }
}
