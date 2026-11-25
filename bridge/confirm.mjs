import { randomBytes } from 'node:crypto'

/**
 * The spoken-confirmation gate, and the two other things the user's own words
 * decide: whether a memory may be written and whether one may be erased.
 *
 * Anything that acts on the world on the strength of what the model decided —
 * sending a message, opening a site that is not on the allowlist — goes through
 * the gate. It is built so that the model alone can never satisfy it, and so
 * that a hostile page cannot ride on a "yes" the user gave to something else:
 *
 *   1. The action is PROPOSED. It is stored with the turn that proposed it.
 *      Nothing has happened. There is at most one pending action per kind; a
 *      new proposal replaces the old one.
 *   2. When the proposing turn ends, the BRIDGE announces it aloud and puts the
 *      whole of it on the HUD (the full message, the full address). The model's
 *      account of it is not what the user hears: the model may be the one under
 *      injection. This is the moment the proposal becomes *presented*.
 *   3. It can be confirmed only in the very next utterance after that
 *      announcement, never later, never in the turn that proposed it, and only
 *      if that utterance is the confirmation phrase for that kind of action
 *      ("pode enviar", "pode abrir"), never a bare "sim". A phrase the model
 *      itself just said aloud does not count: it may be an echo of the speaker.
 *   4. A confirmation is spent once, and expires after 60 seconds.
 *
 * Text that arrives inside a web page, an email or a tool result never reaches
 * `getTurn().text`. That field is the browser's transcript of the user's voice,
 * written when a turn begins, and turns are strictly serialised (server.mjs):
 * the counter cannot move while a turn is still running.
 *
 * Turn state belongs to one socket, so a gate is built per connection.
 */

const strip = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** Lower-case, no accents, no punctuation, single spaces. */
export const normalise = (s) =>
  strip(s)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const NAME = '(?:(?:ei|ola|oi|ok)\\s+)?(?:jarvis\\s+)?(?:por favor\\s+)?'
const TAIL = '(?:\\s+(?:senhor|por favor|agora))*'

/**
 * The phrase that confirms each kind of action. Whole-utterance matches on
 * purpose: "manda outra mensagem dizendo…" contains a yes-word and is a new
 * request, not a yes. Not "sim": a bare "sim" comes out of the speaker as easily
 * as out of the user, and answers any question at all.
 */
const PHRASES = {
  send: new RegExp(
    `^${NAME}(?:pode (?:enviar|mandar)(?: a mensagem)?|(?:envia|manda|enviar|mandar) a mensagem|confirmo o envio)${TAIL}$`,
  ),
  nav: new RegExp(`^${NAME}(?:pode abrir(?: o site| o endereco)?|(?:abre|abrir) o (?:site|endereco)|confirmo a abertura)${TAIL}$`),
  // The three ways of acting on a page of the user's own, signed-in browser.
  // Each has a phrase of its own so a yes meant for one cannot be spent on another.
  click: new RegExp(`^${NAME}(?:pode clicar|confirmo o clique)${TAIL}$`),
  type: new RegExp(`^${NAME}(?:pode digitar|confirmo a digitacao)${TAIL}$`),
  form: new RegExp(`^${NAME}(?:pode preencher|confirmo o preenchimento)${TAIL}$`),
}

/** What the user is told to say, per kind. */
export const CONFIRM_WORDS = {
  send: 'pode enviar',
  nav: 'pode abrir',
  click: 'pode clicar',
  type: 'pode digitar',
  form: 'pode preencher',
}

// ---------------------------------------------------------------------------
// Spotting a confirmation phrase inside other text
// ---------------------------------------------------------------------------

const SEP = '[^\\p{L}\\p{N}]+'
const phraseRe = (...words) => new RegExp(`(?<![\\p{L}\\p{N}])${words.join(SEP)}(?![\\p{L}\\p{N}])`, 'giu')

/**
 * The verbs as a speech recogniser writes them: the infinitive with or without
 * its final "r" ("enviar", "enviá", "abri"), which is how Brazilian Portuguese
 * is spoken and so how it is transcribed (docs/SEGURANCA.md, S4).
 */
const SEND = 'envi[aá]r?|mand[aá]r?'
const OPEN = 'abrir?'
const ACT = `${SEND}|${OPEN}|clic[aá]r?|digit[aá]r?|preench[eê]r?`
/** "pode", or "pó de" as a recogniser hears it, then up to two words ("pode, senhor, enviar") and a verb. */
const POSSIBLE = `(?:pode|p[oó]${SEP}de)(?:${SEP}\\p{L}+){0,2}`

/**
 * Every phrase that confirms an action above, in the spellings the speech
 * recogniser would turn into it. Wider than the gate's own patterns on purpose:
 * this scans the middle of a sentence, the gate matches whole utterances.
 */
const CONFIRM_SCANS = [
  new RegExp(`(?<![\\p{L}\\p{N}])${POSSIBLE}${SEP}(?:${ACT})(?![\\p{L}\\p{N}])`, 'giu'),
  phraseRe(`(?:${SEND})`, 'a', 'mensagem'),
  phraseRe(`(?:${OPEN}|abre)`, 'o', '(?:site|endere[cç]o)'),
  phraseRe('confirmo', 'o', '(?:envio|clique|preenchimento)'),
  phraseRe('confirmo', 'a', '(?:abertura|digita[cç][aã]o)'),
  ...Object.values(CONFIRM_WORDS).map((w) => phraseRe(...w.split(' '))),
]

/**
 * "P O D E enviar": letters said one at a time and written with spaces read
 * the same aloud as the word, so a run of single letters is joined first.
 */
const despace = (text) => text.replace(/(?<![\p{L}\p{N}])(?:\p{L}\s+){2,}\p{L}(?![\p{L}\p{N}])/gu, (m) => m.replace(/\s+/g, ''))

/** Does the text contain a phrase the confirmation gate would accept? */
export function hasConfirmationPhrase(text) {
  const s = despace(String(text ?? ''))
  const n = normalise(s)
  return CONFIRM_SCANS.some((re) => {
    re.lastIndex = 0
    return re.test(s) || re.test(n)
  })
}

/** The text with every such phrase replaced by an ellipsis. */
export function neutraliseConfirmation(text) {
  let out = despace(String(text ?? ''))
  for (const re of CONFIRM_SCANS) out = out.replace(re, '…')
  return out
}

/**
 * An address as a person hears it read aloud: percent-escapes decoded, every
 * separator a space. "att.example/pode-abrir" is spoken "att example pode
 * abrir", which is a confirmation phrase once it comes out of the speaker.
 */
export function spokenAddress(href) {
  let text = String(href ?? '')
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(text)
      if (decoded === text) break
      text = decoded
    } catch {
      break
    }
  }
  return text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function isConfirmationFor(kind, text) {
  const re = PHRASES[kind]
  return Boolean(re && re.test(normalise(text)))
}

/** Was `utterance` something the assistant itself just said (the speaker heard by the microphone)? */
export function echoes(utterance, spoken) {
  const u = normalise(utterance)
  if (!u) return false
  return ` ${normalise(spoken)} `.includes(` ${u} `)
}

export const DEFAULT_TTL_MS = 60_000

/**
 * @param {{
 *   getTurn: () => { n: number, text: string, spoken?: string },
 *   now?: () => number,
 *   ttlMs?: number,
 *   onSettle?: (entry: object, state: 'expired' | 'confirmed') => void,
 * }} opts
 *
 * `getTurn().spoken` is what the model said aloud in the previous turn (not the
 * bridge's own announcement), for the echo check.
 */
export function createGate({ getTurn, now = Date.now, ttlMs = DEFAULT_TTL_MS, onSettle = () => {} }) {
  /** @type {Map<string, { id: string, kind: string, data: any, createdTurn: number, presentedTurn: number | null, expiresAt: number }>} */
  const pending = new Map()
  let spentTurn = -1

  const settle = (entry, state) => {
    try {
      onSettle(entry, state)
    } catch {
      /* a card is a courtesy */
    }
  }

  const prune = () => {
    const t = now()
    const turn = getTurn().n
    for (const [id, p] of pending) {
      const expired = p.expiresAt <= t
      // The one utterance that could have confirmed it has come and gone.
      const missed = p.presentedTurn !== null && turn > p.presentedTurn + 1
      if (expired || missed) {
        pending.delete(id)
        if (p.presentedTurn !== null) settle(p, 'expired')
      }
    }
  }

  const notFound = { ok: false, reason: 'Não há ação pendente para confirmar, ou ela expirou.' }

  return {
    /** Store an action to be confirmed later. Nothing is carried out. Replaces any pending action of the same kind. */
    propose(kind, data) {
      prune()
      for (const [id, p] of pending) if (p.kind === kind) pending.delete(id)
      const entry = {
        id: randomBytes(4).toString('hex'),
        kind,
        data,
        createdTurn: getTurn().n,
        presentedTurn: null,
        expiresAt: now() + ttlMs,
      }
      pending.set(entry.id, entry)
      return entry
    },

    /** The unexpired proposal of this kind that `match` accepts, if any. */
    find(kind, match = () => true) {
      prune()
      for (const p of pending.values()) if (p.kind === kind && match(p.data)) return p
      return null
    },

    has(id) {
      prune()
      return pending.has(id)
    },

    /**
     * The turn `n` ended normally: what it proposed is now presented, so the
     * caller must announce it. The 60 seconds start now, not at the proposal.
     * Returns the entries that became presented.
     */
    present(n) {
      prune()
      const out = []
      for (const p of pending.values()) {
        if (p.createdTurn === n && p.presentedTurn === null) {
          p.presentedTurn = n
          p.expiresAt = now() + ttlMs
          out.push(p)
          const timer = setTimeout(prune, ttlMs + 20)
          timer.unref?.()
        }
      }
      return out
    },

    /** The turn `n` was cancelled: nobody heard what it proposed, so it never happened. */
    discard(n) {
      for (const [id, p] of pending) if (p.createdTurn === n && p.presentedTurn === null) pending.delete(id)
    },

    /**
     * Try to confirm the pending action of this kind (the one `match` accepts).
     * On success it is removed and returned, so a second attempt finds nothing.
     * `reason` is a short Portuguese sentence the model can say.
     */
    confirm(kind, match = () => true) {
      prune()
      let p = null
      for (const candidate of pending.values()) if (candidate.kind === kind && match(candidate.data)) p = candidate
      if (!p) return notFound
      const turn = getTurn()
      if (p.presentedTurn === null || turn.n <= p.createdTurn) {
        return {
          ok: false,
          reason:
            'Ainda não: o sistema precisa anunciar o pedido ao senhor primeiro, e a confirmação tem de vir ' +
            'na fala seguinte à do anúncio. Encerre a sua resposta.',
        }
      }
      if (turn.n !== p.presentedTurn + 1) return notFound
      if (!isConfirmationFor(kind, turn.text)) {
        return {
          ok: false,
          reason:
            `A fala do senhor não foi a frase de confirmação ("${CONFIRM_WORDS[kind] ?? 'sim'}"). ` +
            'Nada foi feito; o pedido caiu. Não tente de novo.',
        }
      }
      if (echoes(turn.text, turn.spoken)) {
        return {
          ok: false,
          reason: 'Essa frase acabou de ser dita pelo próprio assistente, então pode ser eco. Peça ao senhor que confirme de novo.',
        }
      }
      if (spentTurn === turn.n) {
        return { ok: false, reason: 'Uma confirmação vale para uma ação só. Peça outra, numa nova fala.' }
      }
      spentTurn = turn.n
      pending.delete(p.id)
      settle(p, 'confirmed')
      return { ok: true, entry: p }
    },

    /** Drop a proposal (it was carried out, or failed to be). */
    drop(id) {
      pending.delete(id)
    },

    size() {
      prune()
      return pending.size
    },
  }
}

// ---------------------------------------------------------------------------
// What the bridge says, and shows, about a pending action
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

const hostOf = (href) => {
  try {
    return new URL(href).host
  } catch {
    return 'o endereço'
  }
}

/** The part of a nav announcement a person hears for this address. */
function spokenWhere(href) {
  let where = hostOf(href)
  try {
    const u = new URL(href)
    const tail = `${u.pathname === '/' ? '' : u.pathname}${u.search}`
    where = tail.length > 60 ? `${u.host}, com um endereço longo que está na tela` : `${u.host}${tail}`
  } catch {
    /* the host alone will do */
  }
  return where
}

/** The sentence ending shared by every kind: how to confirm, and that anything else cancels. */
const howTo = (kind, verb = 'confirmar') => `Para ${verb}, diga: ${CONFIRM_WORDS[kind]}. Qualquer outra fala cancela.`

/** What is spoken, generated here from the stored action and never from the model's text. */
export function announcement(entry) {
  if (entry.kind === 'send') {
    const text = /[.!?…]$/.test(entry.data.text) ? entry.data.text : `${entry.data.text}.`
    return ` Mensagem pendente para o ${entry.data.channel}: ${text} ${howTo('send', 'enviar')}`
  }
  if (entry.kind === 'nav') {
    return ` Abrir ${spokenWhere(entry.data.url)}? O endereço inteiro está na tela. ${howTo('nav', 'abrir')}`
  }
  if (entry.kind === 'click') {
    const what = entry.data.why ? `${entry.data.why}: ` : ''
    return ` Clicar na página aberta no navegador (${what}${entry.data.ref || `posição ${entry.data.coordinate.join(', ')}`})? ${howTo('click')}`
  }
  if (entry.kind === 'type') {
    return ` Digitar na página aberta: ${entry.data.text}. ${howTo('type', 'digitar')}`
  }
  if (entry.kind === 'form') {
    return ` Preencher o campo ${entry.data.ref} da página aberta com: ${entry.data.value}. ${howTo('form', 'preencher')}`
  }
  return ''
}

/**
 * What a person would hear for this action, as one string: used to refuse an
 * action whose own words contain a confirmation phrase, so the announcement
 * (which the bridge speaks) cannot carry a "yes" planted by whoever wrote them.
 */
export function announcedText(kind, data) {
  if (kind === 'send') return data.text
  if (kind === 'nav') return `${spokenWhere(data.url)} ${spokenAddress(data.url)}`
  if (kind === 'click') return `${data.ref ?? ''} . ${data.why ?? ''}`
  if (kind === 'type') return data.text
  if (kind === 'form') return `${data.ref ?? ''} . ${data.value}`
  return ''
}

/** The HUD card for a pending (or settled) action: the whole text, never a summary. */
export function pendingCard(entry, state = 'pending') {
  const act = (title, label, body, done) => ({
    title,
    label,
    body,
    tags: { pending: 'PENDENTE', confirmed: 'AUTORIZADO', expired: 'EXPIROU' },
    notes: {
      pending: `Diga "${CONFIRM_WORDS[entry.kind]}" na próxima fala. Vale por 60 segundos; qualquer outra fala cancela.`,
      confirmed: done,
      expired: 'Ninguém confirmou a tempo.',
    },
  })
  const kinds = {
    send: {
      title: 'MENSAGEM',
      label: `Para: ${entry.data.channel}`,
      body: entry.data.text,
      tags: { pending: 'PENDENTE', sent: 'ENVIADO', failed: 'NÃO ENVIADO', expired: 'EXPIROU', confirmed: 'CONFIRMADO' },
      notes: {
        pending: `Diga "${CONFIRM_WORDS.send}" na próxima fala. Vale por 60 segundos; qualquer outra fala cancela.`,
        sent: 'Mensagem enviada.',
        failed: 'O envio falhou.',
        expired: 'Ninguém confirmou a tempo.',
        confirmed: 'Confirmado.',
      },
    },
    nav: {
      title: 'ENDEREÇO',
      label: 'Abrir no navegador',
      body: entry.data.url,
      tags: { pending: 'PENDENTE', confirmed: 'AUTORIZADO', expired: 'EXPIROU' },
      notes: {
        pending: `Diga "${CONFIRM_WORDS.nav}" na próxima fala. Vale por 60 segundos; qualquer outra fala cancela.`,
        confirmed: 'Aberto com a sua autorização.',
        expired: 'Ninguém confirmou a tempo.',
      },
    },
    click: act(
      'CLIQUE',
      'Clicar na página aberta',
      `${entry.data.why ? `${entry.data.why} · ` : ''}${entry.data.ref || `posição ${(entry.data.coordinate ?? []).join(', ')}`}`,
      'Clique autorizado.',
    ),
    type: act('DIGITAÇÃO', 'Digitar na página aberta', entry.data.text, 'Digitação autorizada.'),
    form: act('CAMPO', `Preencher o campo ${entry.data.ref}`, String(entry.data.value), 'Preenchimento autorizado.'),
  }[entry.kind]
  const tag = kinds.tags[state] ?? kinds.tags.pending
  return {
    id: `${entry.kind}-${entry.id}`,
    title: `${kinds.title} ${tag}`,
    kind: 'markup',
    html:
      `<div class="hud-rows">` +
      `<div class="hud-row"><div class="hud-main"><div class="hud-label">${esc(kinds.label)}</div>` +
      `<div class="hud-sub">${esc(kinds.body)}</div></div>` +
      `<div class="hud-tag">${esc(tag)}</div></div></div>` +
      `<p class="hud-note hud-dim">${esc(kinds.notes[state] ?? kinds.notes.pending)}</p>`,
    size: 'compact',
    hold: state === 'pending' ? 'sticky' : 'turn',
  }
}

// ---------------------------------------------------------------------------
// Memory: what the user said decides what may be written or erased
// ---------------------------------------------------------------------------

/**
 * The start of an utterance that asks for something to be remembered, matched on
 * the user's own text (accents and case as they come): "lembre que…", "anote
 * que…", "guarde que…". An imperative at the START: a remember-word anywhere
 * else is conversation ("Salve, Jarvis…", "vou precisar de guarda-chuva", "a
 * taxa fixa do banco"), a bare "sim" is nothing, and "lembra de mim?" (do you
 * remember me?) is a question, not an order, so "de" does not count: only
 * "que" and the plain "isso" forms do.
 */
const REMEMBER = new RegExp(
  '^\\s*(?:(?:ei|ol[aá]|oi|ok)[\\s,.!]+)?(?:jarvis[\\s,.!:;]+)?(?:por favor[\\s,.!]+)?' +
    '(?:(?:me\\s+)?lembr[ae](?:-se|\\s+se)?\\s+(?:de\\s+)?que' +
    '|anot[ae](?:\\s+(?:que|a[ií]|isso|isto))?' +
    '|guard[ae]\\s+(?:que|isso|isto)' +
    '|memoriz[ae]' +
    '|registr[ae]\\s+(?:que|isso|isto)' +
    '|n[aã]o\\s+(?:se\\s+)?esque[cç][ae]\\s+que)(?![\\p{L}\\p{N}])[\\s,:;.!-]*',
  'iu',
)

export function isRememberRequest(text) {
  return REMEMBER.test(String(text ?? '').normalize('NFC'))
}

/** The longest thing, in characters, that is kept as one memory. */
export const MAX_MEMORY_CHARS = 500

/**
 * What to remember, taken from the user's own utterance and from nowhere else:
 * the words after the command ("lembre que"), as they were said.
 *
 * The model used to hand over the fact, and a check compared it with the
 * utterance (30% more words allowed, short words ignored). That check could be
 * made to accept "O senhor não toma remédio às 8h" for "lembre que eu tomo
 * remédio às 8h", or a phone number with one digit changed. Nothing a model
 * writes is stored any more: if the utterance asks to remember something, what
 * is kept is what the user said, framed as theirs, so a page that talks the
 * model into calling the tool can at most make it keep a sentence the user spoke.
 *
 * Returns `{ fact }` or `{ problem }` (a sentence fit to give the model).
 */
export function rememberedFact(utterance) {
  const raw = String(utterance ?? '').normalize('NFC')
  const m = REMEMBER.exec(raw)
  if (!m) return { problem: 'a fala do senhor não começou pedindo para lembrar' }
  const rest = raw
    .slice(m[0].length)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (/[?？]/.test(rest)) return { problem: 'o que o senhor disse é uma pergunta, não um fato' }
  if (normalise(rest).length < 3) return { problem: 'faltou dizer o que lembrar, na mesma fala' }
  if (rest.length > MAX_MEMORY_CHARS - 40) return { problem: 'a fala é longa demais para virar uma lembrança' }
  return { fact: `O senhor disse: "${rest.replace(/"/g, "'")}"` }
}

/**
 * The user asks for something to be erased from memory: an erase-word at the
 * start AND either "que …" ("esqueça que meu café é com leite"), "da memória"
 * ("apague da memória o café") or the word "lembrança". The bare verbs are everyday speech: "apague a
 * luz", "remova o alarme", "exclui isso".
 */
const FORGET = new RegExp(`^${NAME}(?:esquec[ae]|apagu?[ae]|remov[ae]|delet[ae]|exclu[ai])\\b(.*)$`)

export function isForgetRequest(text) {
  const m = FORGET.exec(normalise(text))
  if (!m) return false
  const rest = m[1]
  return (
    /^\s+(?:de\s+)?que\b/.test(rest) ||
    /\b(?:da|na|de|desta)\s+(?:minha\s+)?memoria\b/.test(rest) ||
    // "a lembrança do dentista" is a memory, never a light or an alarm.
    /\blembrancas?\b/.test(rest)
  )
}

/**
 * Words that carry meaning, as comparable stems. Short words, pronouns and the
 * "senhor" the assistant writes in place of "eu" are dropped; digits stay, with
 * "7h" and "7 horas" reduced to "7".
 */
const FILLER = new Set(
  'senhor senhora usuario usuaria dele dela seus suas seu sua meu minha meus minhas isso isto esse essa este esta aquilo que sobre para como pelo pela uma umas uns com sem mais muito tambem sempre hora horas'.split(' '),
)

function contentWords(text) {
  return normalise(text)
    .replace(/\b(\d+)\s*(?:h|hs|horas?)\b/g, '$1')
    .split(' ')
    .filter((w) => w && !FILLER.has(w) && (w.length > 3 || /\d/.test(w)))
}

const sameStem = (a, b) => {
  if (a === b) return true
  if (a.length < 4 || b.length < 4) return false
  if (a.slice(0, 4) === b.slice(0, 4)) return true
  return a.slice(0, 3) === b.slice(0, 3) && Math.abs(a.length - b.length) <= 1
}

/**
 * Spelled numbers, as the digits they mean, so "dez" and "10" are the same number.
 * "um" and "uma" are left out: they are articles far more often than numbers.
 */
const SPELLED = {
  dois: '2', duas: '2', tres: '3', quatro: '4', cinco: '5', seis: '6', sete: '7', oito: '8', nove: '9', dez: '10',
  onze: '11', doze: '12', treze: '13', quatorze: '14', catorze: '14', quinze: '15', dezesseis: '16', dezessete: '17', dezoito: '18',
  dezenove: '19', vinte: '20', trinta: '30', quarenta: '40', cinquenta: '50', sessenta: '60', setenta: '70', oitenta: '80',
  noventa: '90', cem: '100', mil: '1000',
}
const NEGATIONS = new Set(['nao', 'nunca', 'jamais', 'sem', 'nem', 'nenhum', 'nenhuma', 'ninguem', 'nada'])

/** Every number in the text, as digits (kept whole: 98888 is not 9888), in order. */
const numbersOf = (norm) => {
  const out = []
  for (const w of norm.replace(/(\d+)\s*(?:h|hs|horas?)\b/g, '$1 ').split(' ')) {
    if (/^\d+$/.test(w)) out.push(w)
    else if (/^\d+[a-z]+$/.test(w)) out.push(w.replace(/[a-z]+$/, ''))
    else if (Object.hasOwn(SPELLED, w)) out.push(SPELLED[w])
  }
  return out
}

const negationsOf = (norm) => norm.split(' ').filter((w) => NEGATIONS.has(w))

/**
 * Was this text taken from what the user said? Null if so, otherwise a sentence.
 * Made of the user's words (30% more allowed) and carrying no number they did
 * not say. By default (`strict`) the negations ("não", "nunca", "sem"…) must also
 * match in number, because "toma" and "não toma" are one stem apart and opposite
 * in meaning: that is the form for anything that would be kept or spoken as the
 * user's own. `{ strict: false }` is for the words that only FIND something (what
 * to forget, which reminder to cancel), where a paraphrase is harmless as long as
 * it points at what the user pointed at.
 */
export function factProblem(fact, utterance, { strict = true } = {}) {
  const f = normalise(fact)
  const u = normalise(utterance)
  if (!f) return 'o fato veio vazio'
  if (/https?:|www\./.test(f) && !/https?:|www\./.test(u)) return 'o fato traz um endereço que o senhor não disse'
  if (f.length > u.length + 40) return 'o fato é bem mais longo do que o que o senhor disse'
  const saidNumbers = numbersOf(u)
  if (numbersOf(f).some((n) => !saidNumbers.includes(n))) return 'o fato traz um número que o senhor não disse'
  if (strict) {
    const want = negationsOf(u).length
    const got = negationsOf(f).length
    if (got !== want) return 'o fato muda uma negação ("não", "nunca", "sem"…) da fala do senhor'
  }
  const words = contentWords(fact)
  const said = contentWords(utterance)
  if (!words.length) return f.length <= u.length && u.includes(f) ? null : 'o fato não está nas palavras do senhor'
  const missing = words.filter((w) => !said.some((s) => sameStem(w, s)))
  const allowed = Math.floor(words.length * 0.3)
  return missing.length <= allowed ? null : 'o fato traz palavras que o senhor não disse'
}

/**
 * Is `text` a stretch of what the user said, word for word (accents, case and
 * punctuation aside)? Null if so. For what is stored or spoken later in the
 * user's name and cannot be rebuilt from the utterance by code (the thing a
 * reminder says), the only text accepted is one the user spoke.
 */
export function verbatimProblem(text, utterance) {
  const t = normalise(text)
  if (!t) return 'o texto veio vazio'
  if (!` ${normalise(utterance)} `.includes(` ${t} `)) {
    return 'o texto não é um trecho, palavra por palavra, da fala do senhor'
  }
  return null
}
