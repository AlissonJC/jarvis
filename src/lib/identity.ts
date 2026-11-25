/**
 * Who the assistant is called, and how the recogniser spells it.
 *
 * Renaming it is a settings change, not a code change: set VITE_ASSISTANT_NAME
 * (and VITE_WAKE_WORDS) in .env.local and JARVIS_NAME for the bridge. See
 * docs/NOME.md. Everything visible that carries the name derives from here.
 *
 * Pure apart from the two env reads, which are optional-chained so the module
 * loads under `node --test`.
 */
import { buildInterrupt, buildWake, echoesSpoken } from './wake.ts'
import { LOCALE } from './locale.ts'

export const DEFAULT_NAME = 'Jarvis'

/**
 * What a pt-BR recogniser actually produces for "Jarvis". Not padding: the name
 * is not in a dictation model's vocabulary, and it returns near-misses for a
 * clear utterance. Better a rare false wake than a name that does not answer.
 * Add the spellings you see in the diagnostics panel (key D, "last drop").
 */
const JARVIS_SPELLINGS = [
  'jarvis',
  'jarves',
  'jarvas',
  'jarbas',
  'jervis',
  'djarvis',
  'jar vis',
  'jarvys',
  'jarviss',
  'travis',
  "java's",
  'jarv',
]

const clean = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '')

/** Comma-separated spellings -> list, lowercased, blanks dropped. */
export function parseWakeWords(raw: unknown): string[] {
  return clean(raw)
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * The spellings to listen for. The name itself is always included; with no
 * VITE_WAKE_WORDS the built-in list applies for "Jarvis" and any other name
 * listens for just itself until you add what the recogniser really produces.
 */
export function wakeVariants(name: string, rawWords: unknown): string[] {
  const explicit = parseWakeWords(rawWords)
  const base =
    explicit.length > 0
      ? explicit
      : name.toLowerCase() === DEFAULT_NAME.toLowerCase()
        ? JARVIS_SPELLINGS
        : []
  return [name.toLowerCase(), ...base]
}

export const ASSISTANT_NAME = clean(import.meta.env?.VITE_ASSISTANT_NAME) || DEFAULT_NAME
export const WAKE_VARIANTS = wakeVariants(ASSISTANT_NAME, import.meta.env?.VITE_WAKE_WORDS)

/** "Jarvis" -> "JARVIS" */
export const NAME_UPPER = ASSISTANT_NAME.toUpperCase()
/** "Jarvis" -> "J.A.R.V.I.S" (the boot title). Spaces and hyphens are dropped. */
export const NAME_DOTTED = [...NAME_UPPER.replace(/[\s-]+/g, '')].join('.')
/** The expansion only makes sense for the original name. */
export const TAGLINE =
  ASSISTANT_NAME.toLowerCase() === DEFAULT_NAME.toLowerCase()
    ? 'Just A Rather Very Intelligent System'
    : 'Assistente pessoal'

/** How the interface tells the user to call it: "ei jarvis" / "hey jarvis". */
export const CALL_PHRASE = `${LOCALE.lang === 'pt' ? 'ei' : 'hey'} ${ASSISTANT_NAME.toLowerCase()}`

const built = buildWake(WAKE_VARIANTS)
export const WAKE = built.wake
export const BARE_NAME = built.bare
export const LEADING_NAME = built.leading
/** True when a transcript is a spoken "stop" in English or Portuguese, or the
 *  name itself. */
export const isSpokenInterrupt = buildInterrupt(WAKE_VARIANTS)

/**
 * A stop word said by the user, as opposed to by him: a spoken interrupt that
 * is not just the words he is saying (or just said) coming back through the
 * microphone. `spoken` is what he is saying now (speakingNow() in tts.ts).
 */
export const isUserInterrupt = (heard: string, spoken: string): boolean =>
  isSpokenInterrupt(heard) && !echoesSpoken(heard, spoken)
