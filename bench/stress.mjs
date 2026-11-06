// Drives the browser-use stress-tests pages (github.com/browser-use/stress-tests) with the CLI and reports which
// ones the page itself says were completed. The pages are someone else's code and are not in this repository:
// clone them and point STRESS_DIR at the clone. Each page serves from a local port; nothing else is loaded.
// Usage: STRESS_DIR=/path/to/stress-tests npm run stress   (builds first; exits 1 when a challenge fails)
// A step names a control by its name, or by `{role}`: the first control of that role in the page's map.
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { promisify } from 'node:util'

const dir = process.env.STRESS_DIR
if (!dir) {
  console.error('set STRESS_DIR to a clone of browser-use/stress-tests')
  process.exit(1)
}
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' }
const server = createServer((req, res) => {
  const file = join(dir, normalize(new URL(req.url, 'http://x').pathname))
  try {
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream')
    res.end(readFileSync(file))
  } catch {
    res.statusCode = 404
    res.end()
  }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/challenges`

const home = mkdtempSync(join(tmpdir(), 'al-stress-'))
const upload = join(home, 'upload.txt')
writeFileSync(upload, 'resume')
const exec = promisify(execFile)
const cli = (...args) => exec(process.execPath, ['dist/cli.js', ...args], { env: { ...process.env, BROWSER_LAYER_HOME: home }, timeout: 120000 })
  .then(r => r.stdout + r.stderr, e => `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`)

// Each challenge: its page, and the commands that complete it.
const CHALLENGES = {
  'radio-selection': ['click "AI"'],
  'checkbox-check': ['check "I accept the challenge"', 'check "I will complete all tasks"', 'check "sneaky html"'],
  'search-squash': ['type {searchbox} squash --enter'],
  'date-time-input': ['type {date} 2026-11-05', 'type {time} 14:30'],
  'slider-drag': ['type {slider} 100'],
  'hover-element': ['hover {clickable}'],
  'multi-select': ['pick {listbox} Apple', 'pick {listbox} Banana'],
  'contenteditable-div': ['type {textbox} banana'],
  'file-upload': [`upload {button} ${upload}`],
  'expand-details': ['click "Click to expand me"'],
  'dropdown-selections': ['pick "Select a color:" Red', 'pick "Select an object:" Ball'],
  'arrow-key-presses': ['click {clickable}', 'press ArrowRight', 'press ArrowRight', 'press ArrowRight'],
  'scroll-accept': ['scroll {scrollable} bottom', 'click "I accept"'],
  'simple-button': ['click "Click me!"'],
  'phone-input': ['type {textbox} 555-1234'],
  'hidden-labels-form': ['type "Email Address (required)" a@b.com', 'type "Date of Birth (required)" 1990-01-01', 'pick "State (required)" California', 'click "Email *"', `upload "Upload Document (required)" ${upload}`, 'click "Submit Form"'],
  'non-latin-form': ['type "البريد الإلكتروني *" a@b.com', 'pick "البلد *" مصر', 'type "تاريخ الميلاد *" 1990-01-01', 'click "البريد الإلكتروني"', `upload "رفع المستند *" ${upload}`, 'click "إرسال النموذج"'],
  'iframe-inception-form': ['type "First Name *" Ann', 'type "Last Name *" Lee', 'type "Email Address *" a@b.com', 'type "Address *" "1 Main St"', 'type "City *" Town', 'pick "State *" Texas', 'type "Zip Code *" 12345', 'check "I agree to the Terms and Conditions *"', 'click "Submit Form"'],
}
const DONE = /Challenge completed successfully|Success!|The secret is/

let failed = 0
for (const [name, steps] of Object.entries(CHALLENGES)) {
  const map = await cli('tab', `${base}/${name}.html`)
  const log = []
  for (const step of steps) {
    const line = step.replace(/\{(\w+)\}/g, (_, role) => map.match(new RegExp(`\\[(\\d+)\\] ${role}\\b`))?.[1] ?? `NO-${role}`)
    log.push(`${line}: ${(await cli(...line.match(/"[^"]*"|\S+/g).map(w => w.replace(/^"|"$/g, '')))).split('\n')[0]}`)
  }
  // Some pages complete a moment after the action (a hover held for a second): look again before failing.
  let page = ''
  for (let k = 0; k < 6 && !DONE.test(page); k++) {
    if (k) await new Promise(r => setTimeout(r, 500))
    page = await cli('read')
  }
  const ok = DONE.test(page)
  if (!ok) failed++
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok ? '' : `\n      ${log.join('\n      ')}`}`)
}
await cli('stop')
server.close()
rmSync(home, { recursive: true, force: true })
console.log(`${Object.keys(CHALLENGES).length - failed} of ${Object.keys(CHALLENGES).length} challenges completed`)
process.exit(failed ? 1 : 0)
