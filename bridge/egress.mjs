/**
 * One answer to "may this machine be made to contact that address?".
 *
 * A prompt-injected model has exactly one way to move private data off this
 * machine without any write tool: compose a URL that carries it, then get the
 * bridge to request it. WebFetch does that, so do the bridge's own proxies
 * (`/img`, `/media`, `/page`, which fetch whatever URL a panel or blade names)
 * and a navigation of the user's browser. Five doors, one rule, so the rule
 * lives here and every door calls the same function.
 *
 * The rule, in order:
 *
 *   1. A URL longer than MAX_EGRESS_URL is refused. Data needs room.
 *   2. A host on the allowlist (and not one of its open redirectors) is fine.
 *   3. A URL the model was HANDED, as opposed to one it wrote, is fine. What it
 *      was handed is exactly three things (docs/SEGURANCA.md, N1 and S1): what the
 *      user said, the hits of a web search (the STRUCTURED result the CLI hands
 *      a PostToolUse hook, never the text of it), and addresses the bridge
 *      itself took out of a page it fetched and granted by code. That is what
 *      keeps news thumbnails and "read this page" working.
 *
 *      Everything else is something a model wrote, or something a model-written
 *      prompt was echoed back through: the line a search tool prints with the
 *      query in it, a page summariser's answer, the title of a blade, the id of
 *      an orbit. An address that first appeared in an INPUT the model wrote
 *      (`noteInput`) never counts as handed over afterwards, however it comes
 *      back. That closes the laundering route where the model composes
 *      `https://att.example/p.png?d=<private data>` and gets a tool to repeat it.
 *   4. Otherwise: if this session has read private data (mail, calendar, memory,
 *      the camera, page text, files) it is refused, because that is exactly
 *      what a composed URL would be carrying. If it has not, it is allowed.
 *
 * "Session", not "turn": the model's context outlives a turn, so a calendar
 * read two questions ago is still there to be leaked by a page read now. The
 * session is one WebSocket connection, and a new page load starts clean.
 *
 * What this does not close, and says so: a URL copied from a hostile result can
 * still be fetched, so an attacker who can plant a list of URLs can still learn
 * *which one was chosen*. That is a few bits per request, not a mailbox.
 */

/** The longest URL, in characters, that may be fetched or opened. */
export const MAX_EGRESS_URL = 300

/** Most URLs remembered per session; the oldest are forgotten first. */
const MAX_SEEN = 1000
/** One tool result can mention thousands; only this many are kept from it. */
const MAX_PER_TEXT = 300
const MAX_URL_LENGTH = 2000

/**
 * Entries are `host` (the host and its subdomains) or `=host` (that exact host).
 * Shared with the navigation allowlist in policy.mjs.
 */
export const hostAllowed = (host, list) =>
  list.some((raw) => {
    // An entry may carry a path (`=www.google.com/search`); only the host counts here.
    const entry = raw.replace(/\/.*$/, '')
    return entry.startsWith('=') ? host === entry.slice(1) : host === entry || host.endsWith(`.${entry}`)
  })

/**
 * A URL path reduced to what a server will most likely route on, or null when
 * it cannot be judged (which callers treat as "refuse").
 *
 * The allowlists and the redirector patterns read paths, and a path can be
 * spelled many ways that reach the same handler: `//url`, `/%75rl`, `/url/`,
 * `/search%2F..%2Furl`, `/search;x/../url`, `\url`. So it is percent-decoded
 * until it stops changing (more than a few rounds is itself the evasion), the
 * backslash becomes a slash, `;params` go, repeated slashes collapse, `.` and
 * `..` are resolved, and the result is lower-cased.
 */
export function normalisePath(pathname) {
  let p = String(pathname ?? '')
  for (let round = 0; ; round++) {
    if (round > 4) return null
    let decoded
    try {
      decoded = decodeURIComponent(p)
    } catch {
      return null
    }
    if (decoded === p) break
    p = decoded
  }
  p = p.replace(/\\/g, '/').replace(/;[^/]*/g, '')
  const out = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`.toLowerCase()
}

/** `=host/path` -> { exact, host, path }. */
export function parseEntry(entry) {
  const exact = entry.startsWith('=')
  const rest = exact ? entry.slice(1) : entry
  const slash = rest.indexOf('/')
  return slash === -1
    ? { exact, host: rest, path: null }
    : { exact, host: rest.slice(0, slash), path: rest.slice(slash) }
}

/**
 * May this host and path be reached without anything else vouching for it?
 * `pathname` is run through normalisePath here, so a caller cannot forget to;
 * a path that cannot be normalised is never allowed.
 */
export function navAllowed(host, pathname, list) {
  const path = normalisePath(pathname)
  if (path === null) return false
  return list.some((entry) => {
    const e = parseEntry(entry)
    if (!hostAllowed(host, [e.exact ? `=${e.host}` : e.host])) return false
    if (e.path === null) return true
    if (e.path === '/') return path === '/'
    const want = e.path.toLowerCase()
    return path === want || path.startsWith(`${want}/`)
  })
}

/**
 * Open redirectors, and services that fetch or forward whatever the query says,
 * on hosts that are otherwise trusted. `google.com/url?q=` is the classic: the
 * host is on every allowlist and the page forwards to whatever the query names;
 * `/s2/favicons?domain=` makes Google look up (and so announce to the DNS of) a
 * name of the caller's choosing. These never count as allowlisted.
 */
const REDIRECTORS = [
  [
    /(^|\.)google\.[a-z.]+$/,
    /^\/(url|amp(\/|$)|imgres|aclk|travel\/clk|search\/about|appserver|local(\/|$)|maps\/dir|s2(\/|$)|translate|gen_204|pagead|ads\/|webhp|complete\/|_\/)/i,
  ],
  [/(^|\.)youtube\.com$/, /^\/(redirect|attribution_link|oembed)/i],
  [/(^|\.)youtu\.be$/, /^\/(redirect)/i],
  [/(^|\.)(bing|duckduckgo|yahoo)\.com$/, /^\/(ck\/a|l\/|\*\/|r\/)/i],
  [/(^|\.)(facebook|l\.facebook|lm\.facebook)\.com$/, /^\/l\.php/i],
  [/(^|\.)(t\.co|bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|is\.gd|buff\.ly)$/, /./],
]

export function isRedirector(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const path = normalisePath(url.pathname)
  if (path === null) return true
  // "I'm feeling lucky": a search that answers with a redirect to its first hit.
  if (/(^|\.)google\.[a-z.]+$/.test(host) && url.searchParams.has('btnI')) return true
  return REDIRECTORS.some(([h, p]) => h.test(host) && p.test(path))
}

/** `href` with the fragment removed: the server never sees it, so it is not a different request. */
const key = (url) => {
  const u = new URL(url)
  u.hash = ''
  return u.href
}

/**
 * Pull http(s) URLs out of free text, JSON or markup. Tolerant of the ways a
 * URL is wrapped (`\/`, `&`, `&amp;`, trailing punctuation) because the
 * model copies what it read, and what it read was not always written plainly.
 */
export function extractUrls(raw) {
  const text = String(raw ?? '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
  const out = new Set()
  const pattern = /https?:\/\/[^\s<>"'`\\]+/gi
  let m
  while ((m = pattern.exec(text)) !== null && out.size < MAX_PER_TEXT) {
    let candidate = m[0]
    if (candidate.length > MAX_URL_LENGTH) continue
    // The address as found, then with the punctuation that wraps it peeled off
    // one character at a time; a closing bracket stays while it is balanced
    // (`/wiki/Foo_(bar)` is an address, `(see https://x.example/a)` is not).
    for (;;) {
      try {
        out.add(key(candidate))
      } catch {
        /* not a URL after all */
      }
      const last = candidate.at(-1)
      if (!/[)\]}.,;:!?*_]/.test(last)) break
      if (last === ')' && (candidate.match(/\(/g) ?? []).length >= (candidate.match(/\)/g) ?? []).length) break
      candidate = candidate.slice(0, -1)
    }
  }
  return [...out]
}

/**
 * An address reduced to what a server would treat as the same request, for
 * comparing what the model wrote with what it later "receives": host in lower
 * case without the default port, path normalised (dot segments, repeated
 * slashes, percent-escapes, `;params`), query parameters sorted with the empty
 * ones dropped (`?d=Z&` is `?d=Z`), no fragment. Null when it cannot be judged.
 */
export function canonicalUrl(raw) {
  try {
    const u = new URL(raw)
    const path = normalisePath(u.pathname)
    if (path === null) return null
    const params = u.search
      .replace(/^\?/, '')
      .split('&')
      .filter(Boolean)
      .sort()
    return `${u.protocol}//${u.host.toLowerCase().replace(/\.$/, '')}${path}${params.length ? `?${params.join('&')}` : ''}`
  } catch {
    return null
  }
}

/** The same, down to host and path: two addresses that differ only in their query are one page. */
const pathKey = (raw) => canonicalUrl(raw)?.replace(/\?.*$/, '') ?? null

/**
 * The hits of a web search, from the structured output the CLI hands a
 * PostToolUse hook (`tool_response`, the SDK's WebSearchOutput): `results` is a
 * list of either `{ tool_use_id, content: [{ title, url }] }` objects, which are
 * what the search engine returned, or plain strings, which are the comment the
 * inner model wrote about them. Only the `url` of the objects counts. The text
 * the model reads (`Links: [...]`, the summary, the echoed query) is never
 * looked at: a model that was talked into repeating a line there could forge
 * an address that way (docs/SEGURANCA.md, S1).
 */
export function searchHitUrls(response) {
  const out = []
  const results = response && typeof response === 'object' ? response.results : null
  if (!Array.isArray(results)) return out
  for (const entry of results) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.content)) continue
    for (const hit of entry.content) {
      const url = hit && typeof hit === 'object' && typeof hit.url === 'string' ? hit.url : null
      if (!url || url.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(url)) continue
      try {
        out.push(key(url))
      } catch {
        /* not a URL */
      }
      if (out.length >= MAX_PER_TEXT) return out
    }
  }
  return out
}

/**
 * The PostToolUse hook for WebSearch (`matcher: 'WebSearch'`): the hits become
 * addresses the session was handed. Never throws, never changes the result.
 */
export function createSearchHitHook(egress) {
  return async (input) => {
    try {
      if (input?.tool_name === 'WebSearch') for (const href of searchHitUrls(input.tool_response)) egress.grantSearchHit(href)
    } catch {
      /* a result that cannot be read grants nothing */
    }
    return {}
  }
}

/** Every string in a tool's input, however deeply it is nested (bounded). */
function inputStrings(value, budget = { n: 0 }, depth = 0) {
  if (depth > 6 || budget.n > 200_000) return []
  if (typeof value === 'string') {
    budget.n += value.length
    return [value]
  }
  if (Array.isArray(value)) return value.flatMap((v) => inputStrings(v, budget, depth + 1))
  if (value && typeof value === 'object') return Object.values(value).flatMap((v) => inputStrings(v, budget, depth + 1))
  return []
}

/**
 * The decision. `seen` is a function `(href) => boolean`; `allow` the host list.
 * Returns a short sentence when refused (it may be spoken) or null.
 */
export function egressProblem(raw, { tainted = false, seen = () => false, allow = [], max = MAX_EGRESS_URL } = {}) {
  const text = String(raw ?? '').trim()
  let url
  try {
    url = new URL(text)
  } catch {
    return 'that is not a valid address'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'only http and https addresses are allowed'
  if (text.length > max || url.href.length > max) return `the address is longer than ${max} characters`
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (navAllowed(host, url.pathname, allow) && !isRedirector(url)) return null
  if (seen(key(url.href))) return null
  if (tainted) {
    return (
      'this session has read private data (mail, calendar, memory, camera, page text or files), ' +
      'so it may only open addresses that were in the user\'s own words, in a search result, on a page the bridge read, or on the list of trusted sites'
    )
  }
  return null
}

/** Allowed hosts for fetches: the navigation list plus JARVIS_EGRESS_ALLOW. */
export function egressAllowList(navAllow, env = process.env) {
  const extra = (env.JARVIS_EGRESS_ALLOW ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return [...navAllow, ...extra]
}

/**
 * Tools whose results are, or may be, private to the user. Using one marks the
 * session. `publicServers` are MCP servers known to return only public data
 * (web search and the like); any other third-party server is treated as private
 * because "a tool I did not write" is not evidence that it is harmless.
 */
export function taintsSession(name, publicServers = new Set()) {
  if (/^(Read|Grep|Glob|NotebookEdit|Bash)$/.test(name)) return true
  if (!name.startsWith('mcp__')) return false
  const server = name.split('__')[1]
  const tool = name.split('__').slice(2).join('__')
  // search_memory and forget_memory hand back what was stored; ask_local_model
  // answers from a service that, depending on how it is set up, may inject the
  // memory into the prompt itself. Whatever it says may carry the user's data.
  if (server === 'jarvis_core') return /^(search_memory|forget_memory|ask_local_model)$/.test(tool)
  // Everything that reads the user's own, signed-in browser: the page, its tree,
  // its console and network, a picture of it, and even the list of open tabs
  // (their origins say where the user is logged in). Only navigation, which
  // reports nothing about the page, is left out.
  if (server === 'jarvis_chrome') return tool !== 'chrome_navigate'
  if (server === 'jarvis_eyes') return true
  // The reminder texts are the user's own private notes.
  if (server === 'jarvis_reminders') return /^(list_reminders|cancel_reminder)$/.test(tool)
  if (server === 'jarvis' || server === 'jarvis_ui') return false
  if (publicServers.has(server)) return false
  return true
}

/**
 * Tools that bring outside text into the conversation, and so are where an
 * injected instruction can come from. Used to refuse a memory write in a turn
 * that has read anything from outside.
 */
export function readsExternal(name) {
  if (!name.startsWith('mcp__')) return !/^(TodoWrite|ToolSearch)$/.test(name)
  const server = name.split('__')[1]
  return !(server === 'jarvis' || server === 'jarvis_ui' || server === 'jarvis_core' || server === 'jarvis_reminders')
}

/**
 * One session's record: has it read private data, and which URLs has it been
 * handed (and which has it merely written). Built per WebSocket connection.
 *
 * `granted(href)` lets the session ask the hub whether the bridge itself vouched
 * for an address (the images of an article it rendered), so the blade tool can
 * be told the same thing the HTTP route will say.
 */
export function createEgress({ allow = () => [], publicServers = new Set(), granted = () => false } = {}) {
  // Every set is keyed by the canonical form of an address (canonicalUrl), so
  // `?d=Z` and `?d=Z&`, `HOST` and `host`, `?b=2&a=1` and `?a=1&b=2` are one entry.
  /** What the user said: theirs to use, whatever else happens to the address. */
  const said = new Set()
  /** What a search engine returned (the structured hits), or the bridge took out of a page it fetched. */
  const received = new Set()
  /** Addresses that first appeared in something the model wrote, whole and down to host and path. */
  const authored = new Set()
  const authoredPaths = new Set()
  let tainted = false
  let taintedBy = null
  let external = false

  const remember = (set, href) => {
    set.delete(href)
    set.add(href)
    while (set.size > MAX_SEEN) set.delete(set.values().next().value)
  }

  const toKey = (href) => {
    try {
      return key(href)
    } catch {
      return null
    }
  }
  /** The canonical entry for `href`, or null when it is not an address at all. */
  const entry = (href) => (toKey(href) === null ? null : (canonicalUrl(href) ?? toKey(href)))
  const entryPath = (href) => pathKey(href) ?? toKey(href)

  const self = {
    get tainted() {
      return tainted
    },
    get taintedBy() {
      return taintedBy
    },
    /** True once this turn has used a tool that reads outside content. */
    get externalThisTurn() {
      return external
    },
    taint(by = 'private data') {
      if (!tainted) taintedBy = by
      tainted = true
    },
    markExternal() {
      external = true
    },
    /** A tool is about to run: mark the session if what it returns may be private, or hostile. */
    onToolUse(name) {
      if (taintsSession(name, publicServers)) self.taint(name)
      if (readsExternal(name)) external = true
    },
    /**
     * A tool is about to be called with this input, which the model wrote. Every
     * address in it is the model's own, unless it was already handed over: if it
     * ever shows up in a result, that is an echo, not news.
     */
    noteInput(name, input) {
      for (const text of inputStrings(input)) {
        for (const href of extractUrls(text)) {
          const e = entry(href)
          if (e === null || said.has(e) || received.has(e) || granted(toKey(href))) continue
          remember(authored, e)
          remember(authoredPaths, entryPath(href))
        }
      }
    },
    /**
     * Text a tool returned. It grants nothing, whatever tool it is and whatever
     * it says: it is written, or echoed, by a model, and an address in it is not
     * evidence of anything. (A web search used to be believed when a line of its
     * text said `Links:`; the hits now come from the structured result,
     * `grantSearchHit`, docs/SEGURANCA.md S1.) Kept so callers need not change.
     */
    onToolResult() {},
    /**
     * A hit the search engine returned (the structured `results` of a WebSearch, see
     * searchHitUrls). It does not count when the model had already written that
     * address, or one with the same host and path: a hit that matches what the
     * model composed was composed, not found.
     */
    grantSearchHit(href) {
      const e = entry(href)
      if (e === null || authored.has(e) || authoredPaths.has(entryPath(href))) return
      remember(received, e)
    },
    /** A new utterance from the user: the per-turn flags reset, the session's do not. */
    newTurn() {
      external = false
    },
    /** The user said these addresses (the transcript of their voice): theirs to use. */
    see(text) {
      for (const href of extractUrls(text)) {
        const e = entry(href)
        if (e !== null) remember(said, e)
      }
    },
    /** The bridge itself took this address out of a page it fetched: it grants it. */
    grant(href) {
      const e = entry(href)
      if (e !== null) remember(received, e)
    },
    /** Did the model write this address, or one of the same host and path, into a tool call before it was handed to it? */
    wasAuthored(href) {
      const e = entry(href)
      return e !== null && (authored.has(e) || authoredPaths.has(entryPath(href)))
    },
    hasSeen(href) {
      const e = entry(href)
      if (e === null) return false
      if (said.has(e)) return true
      return !authored.has(e) && (received.has(e) || granted(toKey(href)))
    },
    check(url) {
      return egressProblem(url, { tainted, seen: self.hasSeen, allow: allow() })
    },
    /**
     * A redirect on the way to `start` leads to `hop`. If `start` was itself
     * handed over, so is where it goes (the address held nothing the model put
     * there). If it was allowed only because its host is trusted, the hop has to
     * be judged on its own: an open redirector on a trusted host is exactly how
     * a composed address would get out.
     */
    checkHop(start, hop) {
      return self.hasSeen(start) ? null : self.check(hop)
    },
  }
  return self
}

/**
 * The bridge's HTTP routes are not tied to a socket, so they ask every live
 * session. Strict where it matters: a URL passes only if it passes for the
 * union of what every live session has seen, and any tainted session taints
 * the answer. With no live session nothing is fetched at all, because a panel
 * cannot exist without one.
 *
 * `granted` holds URLs the bridge itself wrote into a page it served (the
 * images of a reader-mode article), which no model composed. A session that
 * wrote the address itself does not get it vouched for this way.
 */
export function createEgressHub({ allow = () => [] } = {}) {
  /** @type {Set<ReturnType<typeof createEgress>>} */
  const live = new Set()
  const granted = new Set()
  const isGranted = (href) => granted.has(href) && ![...live].some((s) => s.wasAuthored(href))
  const hub = {
    add: (session) => live.add(session),
    remove: (session) => live.delete(session),
    get size() {
      return live.size
    },
    grant(href) {
      try {
        const k = key(href)
        granted.delete(k)
        granted.add(k)
        while (granted.size > MAX_SEEN) granted.delete(granted.values().next().value)
      } catch {
        /* not a URL */
      }
    },
    /** Did the bridge itself vouch for this address? (For a session's own check.) */
    isGranted,
    check(url) {
      if (!live.size) return 'there is no open session to show this to'
      const sessions = [...live]
      return egressProblem(url, {
        tainted: sessions.some((s) => s.tainted),
        seen: (href) => isGranted(href) || sessions.some((s) => s.hasSeen(href)),
        allow: allow(),
      })
    },
    /** A redirect from `start` to `hop`: see `checkHop` on a session. */
    checkHop(start, hop) {
      if (!live.size) return 'there is no open session to show this to'
      let startKey
      try {
        startKey = key(start)
      } catch {
        return hub.check(hop)
      }
      if (isGranted(startKey) || [...live].some((s) => s.hasSeen(startKey))) return null
      return hub.check(hop)
    },
  }
  return hub
}
