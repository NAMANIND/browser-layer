// Record and replay with the same seeded Math.random, so a page rebuilds the exact requests it made
// when recorded (request ids, cache busters) and replay matches them. The clock stays real: apps
// stall when time stops moving.
const SEEDED_RANDOM = `(() => {
  let s = 0x2f6b9a1d
  Math.random = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
})()`

export const deterministic = page => page.addInitScript(SEEDED_RANDOM)
