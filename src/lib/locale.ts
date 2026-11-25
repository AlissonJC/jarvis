/**
 * Language of the assistant (speech recognition, browser voice, wording).
 *
 * One setting, VITE_LANG, a BCP-47 tag. Default pt-BR. Everything that used to
 * hardcode 'en-GB' (the recogniser in voice.ts, the browser-voice ranking in
 * tts.ts) reads it from here.
 *
 * The functions are pure and take the locale as an argument so they can be
 * tested under `node --test` without a browser. `import.meta.env` does not
 * exist outside Vite, hence the optional chain.
 */

export type Locale = {
  /** Normalised tag, e.g. 'pt-BR'. What SpeechRecognition.lang and
   *  SpeechSynthesisUtterance.lang receive. */
  tag: string
  /** Primary language subtag, lowercase, e.g. 'pt'. */
  lang: string
}

export const DEFAULT_LANG = 'pt-BR'

/** 'pt_br', 'PT-br', ' pt-BR ' -> 'pt-BR'. Anything unusable -> the default. */
export function parseLocale(raw: unknown): Locale {
  const value = typeof raw === 'string' ? raw.trim().replace(/_/g, '-') : ''
  const m = /^([a-zA-Z]{2,3})(?:-([a-zA-Z]{2}|\d{3}))?$/.exec(value)
  if (!m) return parseLocale(DEFAULT_LANG)
  const lang = m[1].toLowerCase()
  const region = m[2]?.toUpperCase()
  return { tag: region ? `${lang}-${region}` : lang, lang }
}

export const LOCALE: Locale = parseLocale(import.meta.env?.VITE_LANG)

/**
 * How well a voice's own language tag fits the locale.
 *   2 — same language and same region (pt-BR for pt-BR)
 *   1 — same language, other region (pt-PT, or a bare 'pt')
 *   0 — a different language
 * Tags arrive as 'pt-BR' (Chrome) or 'pt_BR' (some Android/Linux engines).
 */
export function langFit(voiceLang: string, locale: Locale = LOCALE): 0 | 1 | 2 {
  const v = voiceLang.trim().replace(/_/g, '-').toLowerCase()
  if (v === locale.tag.toLowerCase()) return 2
  if (v === locale.lang || v.startsWith(`${locale.lang}-`)) return 1
  return 0
}
