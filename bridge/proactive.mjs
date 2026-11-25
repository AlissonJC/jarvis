import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join as joinPath, resolve as resolvePath } from 'node:path'
import { hasConfirmationPhrase, neutraliseConfirmation, normalise } from './confirm.mjs'
import { ensurePrivateDir } from './private-dir.mjs'
import { assistantNames, maskAssistantName } from './assistant-name.mjs'

/**
 * The announce channel: the assistant speaking first.
 *
 * Everything else in this bridge answers the user. This is the one path by which
 * something the user did not just say reaches the speaker: a reminder that came
 * due, the morning briefing, a message a local script posts to `/announce`. It
 * is built so that none of them can steer the assistant:
 *
 *   - An announcement is TEXT TO BE SPOKEN AND SHOWN, nothing else. It is never
 *     handed to the model, never added to a turn, never read by any tool. The
 *     model does not learn that it happened.
 *   - The text is stripped of control characters, markup and addresses, capped,
 *     the assistant's name and its wake spellings are replaced by "assistente"
 *     (a spoken "Jarvis, ..." would wake it or read as a call to it; S3), and
 *     cleared of the phrases that confirm an action (confirm.mjs): a third
 *     party that can make the speaker say "pode enviar" must not be able to
 *     plant a "yes" for a message the model proposed. Over HTTP such text is
 *     refused; from the bridge's own sources (reminders, briefing) the phrase is
 *     replaced by an ellipsis.
 *   - Nothing is delivered while a confirmation is pending or a turn is running,
 *     checked by the bridge twice: when it pushes the item and again when the
 *     face asks permission to start speaking (`announce_play`). The face cannot
 *     decide that on its own.
 *   - The HTTP route is for local scripts only: loopback peer, a Host the bridge
 *     answers to, no Origin (so no web page), JSON only, a body cap, a separate
 *     secret (JARVIS_ANNOUNCE_TOKEN) compared in constant time, and a rate limit.
 *
 * What is queued survives a restart (a 0600 file). What the user has not yet
 * heard waits for them: for a face to connect, for the face to be idle.
 */

export const MAX_ANNOUNCE_CHARS = 400
export const DEFAULT_TTL_MS = 12 * 3_600_000
export const REMINDER_TTL_MS = 24 * 3_600_000
const MAX_ITEMS = 100
const RECENT_MS = 10 * 60_000
const INFLIGHT_MS = 10 * 60_000
const MAX_ATTEMPTS = 3
const RETRY_AFTER_INTERRUPT_MS = 60_000
const MAX_BODY_BYTES = 2048
/** The longest text taken back from the queue file: the briefing's cap (briefing.mjs), the longest the bridge writes. */
const LOAD_MAX_CHARS = 700

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

export { hasConfirmationPhrase }

const neutralise = neutraliseConfirmation

/** Zero-width and bidi characters change what is read or shown without being visible. */
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿­]/g
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * Plain, speakable text, or a reason it cannot be had.
 *
 * `onLong`: 'refuse' (the HTTP route) or 'truncate' (the bridge's own sources).
 * `onPhrase`: 'refuse' or 'neutralise'. `names`: what the assistant is called
 * and how it is spelled (default: from JARVIS_NAME / JARVIS_WAKE_WORDS); these
 * become "assistente" whatever the source. Returns { text } or { problem }.
 */
export function sanitiseAnnouncement(
  raw,
  { max = MAX_ANNOUNCE_CHARS, onLong = 'refuse', onPhrase = 'refuse', names = assistantNames() } = {},
) {
  if (typeof raw !== 'string') return { problem: 'o texto tem de ser uma string' }
  let t = raw
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(/[\t\n\r\u000b\u000c\u0085]/g, ' ')
    .replace(CONTROL, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ') // what a script or style element holds is not text
    .replace(/<\/?[a-z!][^>]*>/gi, ' ') // markup
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) -> label
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ') // an address read aloud is noise, and a lure
    .replace(/[<>*_`#~|\\^{}[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
  t = maskAssistantName(t, names)
  if (!t) return { problem: 'o texto ficou vazio' }
  if (t.length > max) {
    if (onLong === 'refuse') return { problem: `o texto passa de ${max} caracteres` }
    const cut = t.slice(0, max)
    const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    t = sentence > max * 0.5 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max)}…`
  }
  if (hasConfirmationPhrase(t)) {
    if (onPhrase === 'refuse') return { problem: 'o texto contém uma frase de confirmação do assistente' }
    t = neutralise(t).replace(/\s+/g, ' ').trim()
    if (hasConfirmationPhrase(t)) return { problem: 'o texto contém uma frase de confirmação do assistente' }
  }
  return { text: t }
}

// ---------------------------------------------------------------------------
// A small file, written whole and atomically
// ---------------------------------------------------------------------------

/** Write `data` to `file` through a temporary file in the same folder; mode 0600. */
export function writeFileAtomic(file, data) {
  ensurePrivateDir(dirname(file))
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* a file system without modes */
  }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

const PRIORITIES = new Set(['normal', 'high'])
const KINDS = new Set(['announce', 'reminder', 'briefing'])

const validItem = (o) =>
  o &&
  typeof o === 'object' &&
  typeof o.id === 'string' &&
  /^[a-z0-9]{4,32}$/.test(o.id) &&
  typeof o.text === 'string' &&
  o.text.length > 0 &&
  o.text.length <= 1500 &&
  Number.isFinite(o.createdAt) &&
  Number.isFinite(o.expiresAt) &&
  typeof o.key === 'string'

/**
 * The persistent queue (JSONL, one item per line). Items leave it when the face
 * confirms it has spoken them, when they expire, or after three interrupted tries.
 *
 * @param {{ file: string, now?: () => number, idGen?: () => string, log?: (s: string) => void }} opts
 */
export function createAnnounceQueue({
  file,
  now = Date.now,
  idGen = () => randomBytes(6).toString('hex'),
  log = console.warn,
}) {
  /** @type {Array<{id:string,text:string,priority:string,source:string,kind:string,createdAt:number,expiresAt:number,attempts:number,notBefore:number,key:string}>} */
  let items = []
  /** key -> when it was delivered, so a repeat soon after is not announced again. */
  const recent = new Map()

  const save = () => {
    try {
      writeFileAtomic(file, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''))
    } catch (err) {
      log(`[jarvis] announce queue could not be saved: ${err?.message ?? err}`)
    }
  }

  const load = () => {
    if (!existsSync(file)) return
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      log(`[jarvis] announce queue could not be read: ${err?.message ?? err}`)
      return
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (!validItem(o)) continue
        // The file is not trusted either: another process may have written a line.
        // It gets the cleaning an item gets on the way in, and a line that cannot
        // be cleaned (a confirmation phrase, nothing left) is dropped (S5).
        const clean = sanitiseAnnouncement(o.text, { max: LOAD_MAX_CHARS, onLong: 'truncate', onPhrase: 'refuse' })
        if (clean.problem) continue
        items.push({
          id: o.id,
          text: clean.text,
          priority: PRIORITIES.has(o.priority) ? o.priority : 'normal',
          source: typeof o.source === 'string' ? o.source.slice(0, 24) : 'local',
          kind: KINDS.has(o.kind) ? o.kind : 'announce',
          createdAt: o.createdAt,
          expiresAt: o.expiresAt,
          attempts: Number.isInteger(o.attempts) ? o.attempts : 0,
          notBefore: Number.isFinite(o.notBefore) ? o.notBefore : 0,
          key: o.key,
        })
      } catch {
        /* a damaged line is dropped, not fatal */
      }
    }
    prune()
  }

  function prune() {
    const t = now()
    for (const [k, at] of recent) if (t - at > RECENT_MS) recent.delete(k)
    const before = items.length
    items = items.filter((i) => i.expiresAt > t)
    if (items.length !== before) save()
  }

  load()

  return {
    file,
    /**
     * Queue one announcement. `text` must already be sanitised.
     * Returns { item, duplicate } or { error }.
     */
    add({ text, priority = 'normal', source = 'local', kind = 'announce', ttlMs, dedupeKey }) {
      prune()
      const key = dedupeKey ?? createHash('sha1').update(`${source}|${normalise(text)}`).digest('hex')
      const same = items.find((i) => i.key === key)
      if (same) return { item: same, duplicate: true }
      if (recent.has(key)) return { duplicate: true, item: null }
      if (items.length >= MAX_ITEMS) {
        const victim = items.findIndex((i) => i.kind === 'announce' && i.priority === 'normal')
        if (victim < 0) return { error: 'a fila de avisos está cheia' }
        items.splice(victim, 1)
      }
      const t = now()
      const item = {
        id: idGen(),
        text,
        priority: PRIORITIES.has(priority) ? priority : 'normal',
        source: String(source).slice(0, 24),
        kind: KINDS.has(kind) ? kind : 'announce',
        createdAt: t,
        expiresAt: t + (ttlMs ?? (kind === 'reminder' ? REMINDER_TTL_MS : DEFAULT_TTL_MS)),
        attempts: 0,
        notBefore: 0,
        key,
      }
      items.push(item)
      save()
      return { item, duplicate: false }
    },
    /** Everything still waiting, most urgent first (high before normal, then oldest). */
    list() {
      prune()
      return [...items].sort(
        (a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || a.createdAt - b.createdAt,
      )
    },
    /** The items that may be tried now (not held back after an interruption). */
    due() {
      const t = now()
      return this.list().filter((i) => i.notBefore <= t)
    },
    get(id) {
      return items.find((i) => i.id === id) ?? null
    },
    /** The face reports: 'played' removes it; 'interrupted' tries again later, up to three times. */
    ack(id, status) {
      const i = items.find((x) => x.id === id)
      if (!i) return false
      if (status === 'interrupted' && i.attempts + 1 < MAX_ATTEMPTS) {
        i.attempts += 1
        i.notBefore = now() + RETRY_AFTER_INTERRUPT_MS
      } else {
        items = items.filter((x) => x !== i)
        recent.set(i.key, now())
      }
      save()
      return true
    },
    get size() {
      prune()
      return items.length
    },
  }
}

// ---------------------------------------------------------------------------
// The hub: which connection hears what, and when
// ---------------------------------------------------------------------------

/**
 * The place a face that is not there would be told by something else (Telegram,
 * F6). Called once per item while no face is connected; returns true if the item
 * was delivered some other way. Nothing is delivered externally yet.
 */
export function deliverExternally(/* item */) {
  return false
}

/**
 * @param {{
 *   queue: ReturnType<typeof createAnnounceQueue>,
 *   now?: () => number,
 *   external?: (item: object) => boolean | Promise<boolean>,
 *   log?: (s: string) => void,
 * }} opts
 *
 * A connection is `{ send(msg), open(): boolean, blocked(): boolean }`.
 * `blocked()` is true while a confirmation is pending or a turn is running.
 */
export function createAnnounceHub({ queue, now = Date.now, external = deliverExternally, log = () => {} }) {
  /** Oldest first; the newest open connection is the one that is spoken to. */
  const conns = []
  /** id -> { conn, at, playing } */
  const inflight = new Map()
  const triedExternally = new Set()

  const active = () => {
    for (let i = conns.length - 1; i >= 0; i--) if (conns[i].open()) return conns[i]
    return null
  }

  const frame = (i) => ({
    type: 'announce',
    id: i.id,
    text: i.text,
    priority: i.priority,
    source: i.source,
    kind: i.kind,
    at: i.createdAt,
    expiresAt: i.expiresAt,
  })

  const hub = {
    attach(conn) {
      conns.push(conn)
      hub.pump()
    },
    detach(conn) {
      const k = conns.indexOf(conn)
      if (k >= 0) conns.splice(k, 1)
      for (const [id, f] of inflight) if (f.conn === conn) inflight.delete(id)
      hub.pump()
    },
    /** Push the next due item to the active connection, if it may be told. */
    pump() {
      const t = now()
      for (const [id, f] of inflight) {
        if (!queue.get(id) || t - f.at > INFLIGHT_MS) inflight.delete(id)
      }
      const conn = active()
      const due = queue.due()
      if (!conn) {
        for (const item of due) {
          if (triedExternally.has(item.id)) continue
          triedExternally.add(item.id)
          try {
            Promise.resolve(external(item))
              .then((ok) => ok && queue.ack(item.id, 'played'))
              .catch(() => {})
          } catch {
            /* an external channel is a courtesy */
          }
        }
        return
      }
      if ([...inflight.values()].some((f) => f.conn === conn)) return
      const next = due.find((i) => !inflight.has(i.id))
      if (!next) return
      if (conn.blocked()) return
      inflight.set(next.id, { conn, at: t, playing: false })
      conn.send(frame(next))
      log(`[jarvis] announce ${next.id} (${next.kind}) sent to the face`)
    },
    /** The face wants to start speaking `id`. 'go' only if nothing is pending right now. */
    play(conn, id) {
      const f = inflight.get(id)
      if (!f || f.conn !== conn || active() !== conn || !queue.get(id)) return 'hold'
      if (conn.blocked()) return 'hold'
      f.playing = true
      f.at = now()
      return 'go'
    },
    /** The face finished, or was cut off. */
    ack(conn, id, status) {
      const f = inflight.get(id)
      if (!f || f.conn !== conn) return false
      inflight.delete(id)
      queue.ack(id, status === 'played' ? 'played' : 'interrupted')
      hub.pump()
      return true
    },
    get inflight() {
      return inflight.size
    },
  }
  return hub
}

// ---------------------------------------------------------------------------
// POST /announce
// ---------------------------------------------------------------------------

export const ANNOUNCE_TOKEN_FORM = /^[A-Za-z0-9_-]{24,128}$/

const digestOf = (s) => createHash('sha256').update(s).digest()

export const isLoopbackPeer = (addr) =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || (typeof addr === 'string' && addr.startsWith('127.'))

const sourceName = (raw) => {
  const s = String(raw ?? 'local')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return s || 'local'
}

/**
 * The handler for `POST /announce`. Returns a function `(req, res) => Promise<boolean>`
 * that answers (and returns true) only for this path.
 *
 * @param {{
 *   queue: ReturnType<typeof createAnnounceQueue>,
 *   hub: ReturnType<typeof createAnnounceHub>,
 *   token: string,
 *   hostOk: (host: string | undefined) => boolean,
 *   now?: () => number,
 *   log?: (s: string) => void,
 * }} deps  `token` empty or malformed turns the route off.
 */
export function createAnnounceRoute({ queue, hub, token, hostOk, now = Date.now, log = console.warn }) {
  const enabled = ANNOUNCE_TOKEN_FORM.test(token ?? '')
  const tokenDigest = enabled ? digestOf(token) : null
  /**
   * Failed authentications and accepted posts in the last minute. Both counts are
   * for the whole route, not per caller: ten wrong tokens in a minute from any
   * local process make everyone wait a minute, the real script included. That is
   * an availability cost only, and it is accepted: the peer is loopback, so the
   * caller is another program of this user, and the answer to it is the token
   * (docs/SEGURANCA.md, S6).
   */
  const fails = []
  const posts = []
  const recent = (list) => {
    const t = now()
    while (list.length && t - list[0] > 60_000) list.shift()
    return list.length
  }

  const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
    res.end(JSON.stringify(body))
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      const timer = setTimeout(() => {
        reject(Object.assign(new Error('timeout'), { status: 408 }))
        req.destroy()
      }, 5000)
      req.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY_BYTES) {
          clearTimeout(timer)
          reject(Object.assign(new Error('too big'), { status: 413 }))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        clearTimeout(timer)
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })

  return async (req, res) => {
    let path
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      return false
    }
    if (path !== '/announce') return false
    if (!enabled) {
      reply(res, 503, { ok: false, error: 'o canal de avisos está desligado (JARVIS_ANNOUNCE_TOKEN não está definido)' })
      return true
    }
    if (req.method !== 'POST') {
      reply(res, 405, { ok: false, error: 'use POST' }, { allow: 'POST' })
      return true
    }
    // Only a program on this machine: the peer, the name it used, and no web page.
    if (!isLoopbackPeer(req.socket?.remoteAddress) || !hostOk(req.headers.host) || req.headers.origin) {
      log('[jarvis] refused /announce: not a local script')
      reply(res, 403, { ok: false, error: 'recusado' })
      return true
    }
    if (recent(fails) >= 10) {
      reply(res, 429, { ok: false, error: 'tentativas demais' }, { 'retry-after': '60' })
      return true
    }
    const given =
      /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? String(req.headers['x-announce-token'] ?? '')
    if (!given || given.length > 200 || !timingSafeEqual(digestOf(given), tokenDigest)) {
      fails.push(now())
      log('[jarvis] refused /announce: missing or wrong token')
      reply(res, 401, { ok: false, error: 'token ausente ou errado' })
      return true
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
      reply(res, 415, { ok: false, error: 'envie application/json' })
      return true
    }
    if (recent(posts) >= 20) {
      reply(res, 429, { ok: false, error: 'avisos demais por minuto' }, { 'retry-after': '30' })
      return true
    }
    let body
    try {
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        reply(res, 413, { ok: false, error: 'corpo grande demais' })
        return true
      }
      body = JSON.parse(await readBody(req))
    } catch (err) {
      reply(res, err?.status ?? 400, { ok: false, error: err?.status === 413 ? 'corpo grande demais' : 'JSON inválido' })
      return true
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      reply(res, 400, { ok: false, error: 'esperava um objeto JSON' })
      return true
    }
    const clean = sanitiseAnnouncement(body.text, { onLong: 'refuse', onPhrase: 'refuse' })
    if (clean.problem) {
      reply(res, 400, { ok: false, error: clean.problem })
      return true
    }
    if (body.priority !== undefined && !PRIORITIES.has(body.priority)) {
      reply(res, 400, { ok: false, error: 'priority é "normal" ou "high"' })
      return true
    }
    const added = queue.add({
      text: clean.text,
      priority: body.priority ?? 'normal',
      source: sourceName(body.source),
      kind: 'announce',
    })
    if (added.error) {
      reply(res, 503, { ok: false, error: added.error })
      return true
    }
    posts.push(now())
    if (!added.duplicate) hub.pump()
    log(`[jarvis] announce ${added.duplicate ? 'duplicate ignored' : `queued ${added.item.id}`} from ${sourceName(body.source)}`)
    reply(res, 202, { ok: true, id: added.item?.id ?? null, duplicate: added.duplicate })
    return true
  }
}

/** Where the queue, the reminders and the briefing's day mark live: next to the agent's temp folder (~/.jarvis). */
export const stateDir = (env = process.env, home = process.env.HOME ?? '') =>
  resolvePath(env.JARVIS_STATE_DIR?.trim() || dirname(env.JARVIS_TMP?.trim() || joinPath(home, '.jarvis', 'tmp')))
