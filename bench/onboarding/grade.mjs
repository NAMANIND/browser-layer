// Scores an answer to a scenario: which "must" checks hit, which "not" checks fired, and which
// browser-layer verbs or flags do not exist (the failure that matters most: a guessed command).
// The vocabulary is the one in `browser-layer help` (src/cli.ts); overlap.mjs checks it still is.
export const VERBS = new Set('open verbs do tab go back forward reload tabs use close stop steps each map read find get click dblclick rightclick hover check uncheck submit type pick press drag scroll upload wait dialog explore menu eval net cookies storage allow screenshot show hide login attach install browser update help'.split(' '))
export const FLAGS = new Set('--json --enter --all --desc --gone --keys --full --urls --page --limit --sort --cols --out --session --profile --attach --version --help --with-deps'.split(' '))
const FLAGS_WITH_VALUE = new Set(['--session', '--profile', '--attach', '--page', '--limit', '--sort', '--cols', '--out'])

// Shell-like split on ; && || | outside quotes, then words with quotes removed.
function split(line) {
  const parts = []; let cur = '', q = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) { cur += c; if (c === q) q = ''; continue }
    if (c === '"' || c === "'") { q = c; cur += c; continue }
    if (c === ';' || c === '|' || (c === '&' && line[i + 1] === '&')) { if (c === '&' || line[i + 1] === c) i++; parts.push(cur); cur = ''; continue }
    cur += c
  }
  parts.push(cur)
  return parts.map(s => s.trim()).filter(Boolean)
}
function words(s) {
  const out = []; let cur = '', q = '', has = false
  for (const c of s) {
    if (q) { if (c === q) q = ''; else cur += c; continue }
    if (c === '"' || c === "'") { q = c; has = true; continue }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; continue }
    cur += c; has = true
  }
  if (cur || has) out.push(cur)
  return out
}

// A step inside `steps '…; …'` is a call of its own for what it does, so the checks see each as a browser-layer line.
// The one-call rules look at the original line, which stays in the code.
function unfold(code) {
  const lines = []
  for (const line of code.split('\n')) for (const seg of split(line)) {
    const ws = words(seg.replace(/^(?:[A-Z_]+=\S+\s+)+/, ''))
    if (ws[0] === 'browser-layer' && ws.includes('steps')) lines.push(...split(ws[ws.indexOf('steps') + 1] ?? '').map(step => `browser-layer ${step}`))
  }
  return lines.join('\n')
}

export function codeOf(answer) {
  const blocks = [...answer.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(m => m[1])
  const code = blocks.length ? blocks.join('\n') : answer
  const lines = code.replace(/\\\n\s*/g, ' ').split('\n').map(l => l.replace(/^\s*\$\s+/, '')).join('\n')
  return `${lines}\n${unfold(lines)}`
}

// Every browser-layer call in the code, steps/each inner commands included, checked against the vocabulary.
export function invented(code) {
  const bad = []
  const check = (ws, inner) => {
    const verbAt = ws.findIndex((w, i) => !w.startsWith('--') && !FLAGS_WITH_VALUE.has(ws[i - 1] ?? ''))
    ws.forEach(w => { if (/^--[a-z-]+$/.test(w) && !FLAGS.has(w)) bad.push(`flag ${w}`) })
    const verb = ws[verbAt]
    if (verb === undefined) return
    if (!VERBS.has(verb) && !/^(--|-)/.test(verb)) bad.push(`verb ${verb}`)
    if (verb === 'steps' && ws[verbAt + 1]) split(ws[verbAt + 1]).forEach(s => check(words(s), true))
    if (verb === 'each' && ws[verbAt + 1]) split(ws[verbAt + 1]).forEach(s => check(words(s), true))
  }
  for (const line of code.split('\n')) for (const seg of split(line)) {
    const ws = words(seg.replace(/^(?:[A-Z_]+=\S+\s+)+/, ''))
    if (ws[0] === 'browser-layer') check(ws.slice(1))
  }
  return bad
}

export function grade(scenario, answer) {
  const code = codeOf(answer)
  const hit = c => new RegExp(c.re, 'i').test(c.scope === 'text' ? answer : code)
  const must = scenario.must.map(c => ({ tag: c.tag, ok: hit(c) }))
  const fired = (scenario.not ?? []).map(c => ({ tag: c.tag, ok: !hit(c) }))
  const checks = [...must, ...fired]
  return {
    score: checks.length ? checks.filter(c => c.ok).length / checks.length : 1,
    pass: checks.every(c => c.ok),
    missed: must.filter(c => !c.ok).map(c => c.tag),
    forbidden: fired.filter(c => !c.ok).map(c => c.tag),
    invented: invented(code),
    must: must.map(c => c.tag),
  }
}
