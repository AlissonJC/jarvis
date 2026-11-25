/**
 * Cutting the first sentence of an answer short, so the voice starts sooner.
 *
 * A cloud voice takes roughly as long to synthesise as the sentence is long
 * (plus a fixed round trip), and nothing is heard until the first sentence is
 * done. When that sentence is long, speaking its first clause first means the
 * first sound arrives after a handful of words instead of after twenty, while
 * the rest is synthesised behind it. Only the first sentence of an answer is
 * cut: later ones are already being synthesised while an earlier one plays.
 *
 * Pure and free of browser imports so `node --test` can exercise it.
 */

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length

/**
 * Split at the first comma, semicolon or colon that leaves 6-10 words before it
 * and at least 5 after it. Returns null when there is no such place: a short
 * sentence is better spoken in one piece, with one set of prosody.
 */
export function splitFirstClause(
  text: string,
  minHead = 6,
  maxHead = 10,
  minTail = 5,
): [string, string] | null {
  const re = /[,;:]\s+/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const cut = m.index + 1
    const head = text.slice(0, cut)
    const n = words(head)
    if (n > maxHead) return null
    if (n < minHead) continue
    const tail = text.slice(m.index + m[0].length)
    return words(tail) >= minTail ? [head, tail] : null
  }
  return null
}
