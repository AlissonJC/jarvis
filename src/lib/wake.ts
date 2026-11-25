/**
 * Wake phrase and spoken interruption, as pure functions.
 *
 * Kept free of any Vite or browser dependency so `node --test` can exercise
 * them (see test/wake.test.mjs). The configured name and spellings come from
 * identity.ts; the voice loop imports the ready-made regexes from there.
 *
 * Word boundaries are done with Unicode lookarounds rather than `\b`, because
 * `\b` only knows ASCII letters: it sees no boundary after "já" or before "é".
 */

/** Not a letter or digit on the left / right. */
const NB = '(?<![\\p{L}\\p{N}])'
const NA = '(?![\\p{L}\\p{N}])'

/**
 * Greetings that may precede the name. Sources, not literals, so the accented
 * and unaccented spellings of "olá" both count.
 */
const GREETING = '(?:ei|hey|hi|oi|ol[aá]|ok|okay|yo)'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One spelling as a regex source: spaces inside it ("jar vis") may be absent
 *  or doubled, since recognisers disagree about where to cut a name. */
function spelling(v: string): string {
  return v
    .trim()
    .split(/\s+/)
    .map(escapeRe)
    .join('\\s*')
}

/** Alternation of the spellings, longest first so "jarvis" wins over "jarv". */
export function nameAlternation(variants: string[]): string {
  const seen = new Set<string>()
  const clean = variants
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v && !seen.has(v) && seen.add(v))
    .sort((a, b) => b.length - a.length)
  return clean.map(spelling).join('|')
}

export type WakeRegexes = {
  /** Matches the name anywhere in a transcript, with an optional greeting. */
  wake: RegExp
  /** A bare vocative — "Jarvis", "ei Jarvis" — with nothing asked. */
  bare: RegExp
  /** A leading vocative on a real command, to be stripped from it. */
  leading: RegExp
}

export function buildWake(variants: string[]): WakeRegexes {
  const alt = nameAlternation(variants)
  if (!alt) throw new Error('buildWake: no wake words')
  const head = `(?:${GREETING}[\\s,]+)?(?:${alt})`
  return {
    // The trailing (?!'s) keeps possessives ("Jarvis's job") from waking him.
    wake: new RegExp(`${NB}${head}${NA}(?!['’]s)`, 'iu'),
    bare: new RegExp(`^\\s*${head}[\\s,.!?]*$`, 'iu'),
    leading: new RegExp(`^\\s*${head}${NA}[\\s,.:!?-]*`, 'iu'),
  }
}

/**
 * Words that cut through whatever he is saying.
 *
 * STRONG words are rare enough in ordinary speech to count anywhere in an
 * utterance. WEAK words are also everyday function words in Portuguese ("no",
 * "para", "não", "espera" in "ele espera") and in his own answers; accepted
 * anywhere, they would make his own voice, picked up by the microphone,
 * interrupt him. So they only count when they are (nearly) the whole utterance.
 *
 * The assistant's own name is treated like a weak word, not a strong one: he
 * says it himself ("Eu sou o Jarvis"), so it only interrupts when it is almost
 * the whole utterance ("Jarvis", "ei Jarvis") or sits beside a weak word
 * ("Jarvis, para").
 */
const STRONG =
  'stop|wait|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|' +
  'pare|cancela(?:r)?|cancele|sil[eê]ncio|cala a boca|j[aá] chega|chega de|' +
  'esquece|deixa pra l[aá]|deixa para l[aá]'
const WEAK = 'no|n[aã]o|para|p[aá]ra|espera|aguarda|chega|basta|calma|cala'

/** At most this many words for a weak interrupt (or the bare name) to count. */
const WEAK_MAX_WORDS = 3
/** The name next to a weak word: "Jarvis, para de falar". */
const NAMED_WEAK_MAX_WORDS = 5

export function buildInterrupt(variants: string[]): (text: string) => boolean {
  const names = nameAlternation(variants)
  const strong = new RegExp(`${NB}(?:${STRONG})${NA}`, 'iu')
  const weak = new RegExp(`${NB}(?:${WEAK})${NA}`, 'iu')
  // Same possessive guard as the wake phrase: "Jarvis's job" is not a call.
  const name = names ? new RegExp(`${NB}(?:${names})${NA}(?!['’]s)`, 'iu') : null
  return (text: string) => {
    if (strong.test(text)) return true
    const words = text.trim().split(/\s+/).filter(Boolean).length
    if (words === 0) return false
    const hasWeak = weak.test(text)
    const hasName = name?.test(text) ?? false
    if (words <= WEAK_MAX_WORDS && (hasWeak || hasName)) return true
    return words <= NAMED_WEAK_MAX_WORDS && hasName && hasWeak
  }
}

/** Lowercase, accent-folded words, punctuation dropped. */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Edit distance at most 1 (substitution, insertion or deletion). */
function withinOne(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

/** Same word, allowing one slip of the recogniser on words long enough to bear it. */
const sameWord = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && withinOne(a, b))

/**
 * Is `heard` just the microphone picking up `spoken` — the text he is saying (or
 * has just said) out loud?
 *
 * True when the heard words appear, in order and next to each other, somewhere
 * in what he is saying: accents and punctuation ignored, one recogniser slip
 * tolerated per long word, and for heard phrases of four words or more one
 * missing or wrong word in total. A short phrase must match entirely. This is
 * what keeps "Não encontrei." and "Para o senhor.", said by him, from being
 * mistaken for the user telling him to stop, while a "pare" he never said still
 * gets through. Costs one thing: while he is saying a word himself, the user
 * saying that exact word alone is not heard as an interruption (the energy
 * barge-in still is).
 */
export function echoesSpoken(heard: string, spoken: string): boolean {
  const h = tokens(heard)
  const s = tokens(spoken)
  if (!h.length || h.length > s.length) return false
  const allowed = h.length >= 4 ? 1 : 0
  for (let start = 0; start + h.length <= s.length; start++) {
    let miss = 0
    for (let k = 0; k < h.length && miss <= allowed; k++) {
      if (!sameWord(h[k], s[start + k])) miss++
    }
    if (miss <= allowed) return true
  }
  return false
}
