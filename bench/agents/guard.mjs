// The command guard, run as Claude Code's PreToolUse hook (WAB_TOOL names the CLI being driven, the call arrives as
// JSON on stdin). browser-layer's rules are web-agent-bench's own, loaded from that checkout (WAB), so both runs of
// this benchmark are held to the same text filter; browser-harness's is below. A filter, not a sandbox: the point is
// that every tool answers from the rendered page, not from a fetch or a script that bypasses it.
import { readFileSync } from 'node:fs'

// Helpers and js() on the page's DOM are fine; imports, files, processes, cdp(), http_get and network calls are not.
const DENIED = /\bimport\b|__|\bopen\s*\(|\bexec\b|\beval\s*\(|\bcompile\s*\(|\bsubprocess\b|\bos\s*\.|\bsys\s*\.|\brequests\b|\burllib\b|\bhttp_get\b|\bcdp\s*\(|\bdrain_events\b|\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|document\s*\.\s*cookie|localStorage|sessionStorage|\bcurl\b|\bwget\b/i

function isBrowserHarnessOnly(command) {
  if (/^browser-harness\s+skill\s*$/.test(command.trim())) return true
  const lines = command.trim().split('\n')
  const open = /^browser-harness\s*<<-?\s*(['"]?)(\w+)\1\s*$/.exec(lines[0] ?? '')
  if (!open || lines.length < 3 || lines[lines.length - 1].trim() !== open[2]) return false
  return !DENIED.test(lines.slice(1, -1).join('\n'))
}

const HARNESS_MESSAGE = "Blocked: only `browser-harness <<'PY' … PY` scripts that drive the page with browser-harness's helpers are allowed (new_tab, page_info, click_at_xy, type_text, fill_input, press_key, scroll, wait, wait_for_element, js to read the page's DOM, and so on). No imports, files, processes, cdp(), http_get, fetch or other network calls, cookies or storage, and no shell commands outside the heredoc. Complete the task through the rendered page."

export async function guardFor(tool) {
  if (tool === 'browser-harness') return [isBrowserHarnessOnly, HARNESS_MESSAGE]
  const g = await import(`${process.env.WAB}/src/drivers/cmdGuard.ts`)
  return [g.isBrowserLayerOnly, g.BROWSER_LAYER_GUARD_MESSAGE]
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [ok, reason] = await guardFor(process.env.WAB_TOOL).then(([guard, message]) => {
    const pass = guard(String(JSON.parse(readFileSync(0, 'utf8')).tool_input?.command ?? ''))
    return [pass, pass ? '' : message]
  })
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: ok ? 'allow' : 'deny', permissionDecisionReason: reason } }))
}
