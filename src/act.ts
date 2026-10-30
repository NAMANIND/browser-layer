import type { CDPSession } from 'playwright-core'

// Actions on a browser node id, with trusted input through the DevTools protocol.
// Hit testing uses layout, so none of this needs pixels.

// True when the topmost element at (x, y), through open shadow roots, is the target or inside it.
const RECEIVES_POINTER = `function (x, y) {
  let e = document.elementFromPoint(x, y)
  while (e && e.shadowRoot) { const d = e.shadowRoot.elementFromPoint(x, y); if (!d || d === e) break; e = d }
  for (; e; e = e.parentElement || (e.getRootNode() instanceof ShadowRoot ? e.getRootNode().host : null)) if (e === this) return true
  return false
}`
const SELECT_CONTENTS = `function () {
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) { this.select(); return }
  const range = document.createRange(); range.selectNodeContents(this)
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range)
}`
// Same contract as a user choosing an option: set it, then fire input and change.
const PICK_OPTION = `function (want) {
  if (!(this instanceof HTMLSelectElement)) return 'not a <select>'
  const o = [...this.options].find(o => o.label === want || o.value === want || o.text.trim() === want)
  if (!o) return 'no option "' + want + '"; options: ' + [...this.options].map(o => o.label).join(' | ')
  this.value = o.value
  this.dispatchEvent(new Event('input', { bubbles: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return ''
}`

async function call(cdp: CDPSession, backendNodeId: number, fn: string, args: unknown[] = []): Promise<unknown> {
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId })
  const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId!, functionDeclaration: fn, arguments: args.map(value => ({ value })), returnByValue: true,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

export async function click(cdp: CDPSession, backendNodeId: number) {
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
  const { quads } = await cdp.send('DOM.getContentQuads', { backendNodeId })
  if (!quads.length) throw new Error('it has no box on the page')
  const [q] = quads
  const x = (q[0] + q[2] + q[4] + q[6]) / 4
  const y = (q[1] + q[3] + q[5] + q[7]) / 4
  if (!(await call(cdp, backendNodeId, RECEIVES_POINTER, [x, y]))) throw new Error('another element is on top of it')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

// Replaces the field's content the way typing over a selection does: beforeinput, input, change.
export async function fill(cdp: CDPSession, backendNodeId: number, text: string) {
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
  await cdp.send('DOM.focus', { backendNodeId })
  await call(cdp, backendNodeId, SELECT_CONTENTS)
  if (text) await cdp.send('Input.insertText', { text })
  else for (const type of ['keyDown', 'keyUp'] as const) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
}

export async function pick(cdp: CDPSession, backendNodeId: number, option: string) {
  const problem = await call(cdp, backendNodeId, PICK_OPTION, [option])
  if (problem) throw new Error(String(problem))
}
