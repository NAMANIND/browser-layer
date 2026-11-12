// steps: commands separated by ; or a new line, each read as words the way a shell reads them ('…' and
// "…" quote, \ escapes inside "…"). The text of each step is kept for its line in the answer.
export function script(text: string): { raw: string; words: string[] }[] {
  const steps: { raw: string; words: string[] }[] = []
  let words: string[] = [], word: string | undefined, quote = '', raw = ''
  const end = () => { if (word !== undefined) words.push(word); word = undefined }
  const close = () => { end(); if (words.length) steps.push({ raw: raw.trim(), words }); words = []; raw = '' }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      raw += ch
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) word = (word ?? '') + text[++i], raw += text[i]
      else word = (word ?? '') + ch
    } else if (ch === ';' || ch === '\n') close()
    else {
      raw += ch
      if (ch === '"' || ch === "'") { quote = ch; word ??= '' }
      else if (/\s/.test(ch)) end()
      else word = (word ?? '') + ch
    }
  }
  if (quote) throw new Error(`steps: a ${quote} is not closed`)
  close()
  return steps
}
