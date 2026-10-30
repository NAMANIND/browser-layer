import type { CDPSession } from 'playwright-core'

// Actions on a browser node id, with trusted input through the DevTools protocol.
// Hit testing uses layout, so none of this needs pixels.

// Why the element at (x, y) of this frame is not the target: '' when it is the target or inside it,
// else a short description of what is on top. Walks open shadow roots and same-origin frame offsets.
const BLOCKER = `function (x, y) {
  let w = this.ownerDocument.defaultView
  try { while (w.frameElement) { const f = w.frameElement, r = f.getBoundingClientRect(); x -= r.left + f.clientLeft; y -= r.top + f.clientTop; w = w.parent } } catch {}
  let e = this.ownerDocument.elementFromPoint(x, y)
  while (e && e.shadowRoot) { const d = e.shadowRoot.elementFromPoint(x, y); if (!d || d === e) break; e = d }
  const top = e
  for (; e; e = e.parentElement || (e.getRootNode() instanceof ShadowRoot ? e.getRootNode().host : null)) if (e === this) return ''
  if (!top) return 'nothing is at its position'
  const what = top.getAttribute('aria-label') || top.innerText || ''
  return 'covered by <' + top.tagName.toLowerCase() + '>' + (what ? ' "' + what.trim().slice(0, 40) + '"' : '')
}`
const DISABLED = `function () { return !!this.disabled || this.getAttribute('aria-disabled') === 'true' }`
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
const IS_FILE_INPUT = `function () { return this instanceof HTMLInputElement && this.type === 'file' }`

// Where a node lives: the engine session of its frame, and that frame's offset in the page.
export type Target = { cdp: CDPSession; page: CDPSession; id: number; offset: () => Promise<[number, number]> }

export async function call(t: Target, fn: string, args: unknown[] = []): Promise<unknown> {
  const { object } = await t.cdp.send('DOM.resolveNode', { backendNodeId: t.id })
  const { result, exceptionDetails } = await t.cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId!, functionDeclaration: fn, arguments: args.map(value => ({ value })), returnByValue: true,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Waits until the target can take the pointer: it has a box, is enabled, has stopped moving, and is the
// element at its own center. Returns that center in page coordinates, or fails with the last reason.
export async function pointAt(t: Target, timeoutMs: number): Promise<[number, number]> {
  const end = Date.now() + timeoutMs
  let last: number[] | undefined
  let why = ''
  for (;;) {
    try {
      await t.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: t.id })
      const { quads } = await t.cdp.send('DOM.getContentQuads', { backendNodeId: t.id })
      const q = quads[0]
      if (!q) why = 'it has no box on the page (hidden or not rendered)'
      else if (await call(t, DISABLED)) why = 'it is disabled'
      else if (last && q.some((v, i) => Math.abs(v - last![i]) > 1)) why = 'it is still moving'
      else if (last) {
        const x = (q[0] + q[2] + q[4] + q[6]) / 4
        const y = (q[1] + q[3] + q[5] + q[7]) / 4
        why = String(await call(t, BLOCKER, [x, y]))
        if (!why) {
          const [ox, oy] = await t.offset()
          return [x + ox, y + oy]
        }
      }
      last = q
    } catch (err) {
      if (/No node|Could not find node/i.test(String(err))) throw err
      why = err instanceof Error ? err.message : String(err)
    }
    if (Date.now() >= end) throw new Error(why)
    await sleep(50)
  }
}

export type Pointer = { button?: 'left' | 'right'; clicks?: number; move?: boolean }

export async function pointer(t: Target, timeoutMs: number, { button = 'left', clicks = 1, move = false }: Pointer = {}) {
  const [x, y] = await pointAt(t, timeoutMs)
  await t.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  if (move) return
  for (let n = 1; n <= clicks; n++) {
    await t.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: n })
    await t.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: n })
  }
}

// Replaces the field's content the way typing over a selection does: beforeinput, input, change.
export async function fill(t: Target, text: string) {
  await t.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: t.id })
  await t.cdp.send('DOM.focus', { backendNodeId: t.id })
  await call(t, SELECT_CONTENTS)
  if (text) await t.page.send('Input.insertText', { text })
  else for (const type of ['keyDown', 'keyUp'] as const) await t.page.send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
}

export async function pick(t: Target, option: string) {
  const problem = await call(t, PICK_OPTION, [option])
  if (problem) throw new Error(String(problem))
}

export const isFileInput = async (t: Target) => Boolean(await call(t, IS_FILE_INPUT))

export async function setFiles(t: Target, files: string[]) {
  await t.cdp.send('DOM.setFileInputFiles', { backendNodeId: t.id, files })
}

// Wheel input at the target's center, or at the middle of the viewport: what a user's scroll sends.
export async function wheel(t: Target | undefined, page: CDPSession, deltaY: number, viewport: [number, number], timeoutMs: number) {
  const [x, y] = t ? await pointAt(t, timeoutMs) : [viewport[0] / 2, viewport[1] / 2]
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
}
