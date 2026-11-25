/**
 * What the assistant is called, and every way the speech recogniser spells it.
 *
 * The face wakes on these spellings (src/lib/identity.ts: the name, plus
 * VITE_WAKE_WORDS or, for "Jarvis", a built-in list), so a sentence the assistant
 * speaks that contains one of them wakes it again, or is taken for the user
 * calling it. An announcement (a reminder, the briefing, a local script) is words
 * the bridge speaks, never words addressed to the assistant, so the bridge
 * replaces the name with "assistente" before it is queued or spoken
 * (docs/SEGURANCA.md, S3).
 *
 * The bridge reads the name from JARVIS_NAME and the spellings from
 * JARVIS_WAKE_WORDS (the same list as VITE_WAKE_WORDS; unset, the built-in list
 * for "Jarvis" applies, exactly as in the face). Keep the built-in list below in
 * step with JARVIS_SPELLINGS in src/lib/identity.ts: a test compares them.
 */

const DEFAULT_NAME = 'Jarvis'

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

const words = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)

/** The name and its spellings, lower case, as the face builds them. */
export function assistantNames(env = process.env) {
  const name = env.JARVIS_NAME?.trim() || DEFAULT_NAME
  const explicit = words(env.JARVIS_WAKE_WORDS)
  const base = explicit.length > 0 ? explicit : name.toLowerCase() === DEFAULT_NAME.toLowerCase() ? JARVIS_SPELLINGS : []
  return [...new Set([name.toLowerCase(), ...base])]
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One name as a pattern: the spaces inside it ("jar vis") may be missing or doubled. */
const spelling = (v) => v.split(/\s+/).map(escapeRe).join('\\s*')

/** A case-insensitive pattern for any of `names` as a whole word, longest first. */
export function nameRegex(names) {
  const alt = [...names]
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(spelling)
    .join('|')
  return alt ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'giu') : null
}

/** `text` with the assistant's name, in any spelling, replaced by "assistente". */
export function maskAssistantName(text, names = assistantNames()) {
  const re = nameRegex(names)
  return re ? String(text).replace(re, 'assistente') : String(text)
}

/** Does `text` say the assistant's name, in any spelling? */
export function mentionsAssistant(text, names = assistantNames()) {
  const re = nameRegex(names)
  return re ? re.test(String(text)) : false
}
