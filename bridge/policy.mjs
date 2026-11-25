/**
 * What JARVIS may do, decided in one place.
 *
 * Two layers, and the difference between them is the point of this file:
 *
 *   decideTool(name)         — the policy by tool *name*: which built-ins and
 *                              MCP tools count as reads and which need
 *                              JARVIS_ALLOW_WRITES. Unchanged from when it lived
 *                              in server.mjs.
 *   checkToolUse(name, input) — the same policy plus the *arguments*: where a
 *                              file tool is pointed, what a fetch is aimed at.
 *
 * The second one exists because of where it is enforced. canUseTool is not
 * consulted for every call: the CLI settles some itself before asking — a Read
 * inside the working directory, a shell command its classifier considers
 * read-only (`cat`, `ls`, `grep` …) — and those run without the callback ever
 * seeing them. Measured on @anthropic-ai/claude-agent-sdk 0.3.220 with a
 * canUseTool that denied everything: `Bash: cat ~/secret.txt` ran and its
 * output reached the model. A PreToolUse hook, by contrast, sees every call
 * before it runs, auto-approved or not, and its deny is final. So the bridge
 * enforces through the hook, and canUseTool stays as the second gate it
 * always was.
 */

import { lookup } from 'node:dns/promises'
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import { blockedAddress, vetTarget } from './net.mjs'
import { MAX_EGRESS_URL, egressProblem, isRedirector, navAllowed } from './egress.mjs'
import { announcedText, hasConfirmationPhrase, neutraliseConfirmation } from './confirm.mjs'

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
export const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
export const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/** MCP tools arrive as `mcp__<server>__<tool>`. */
const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * Account connectors — the mail, calendar, drive and so on attached to the
 * user's claude.ai account — arrive in the session as MCP servers named
 * `claude_ai_<Name>`: `mcp__claude_ai_Gmail__search_threads`,
 * `mcp__claude_ai_Magnific__images_generate`. (The CLI turns "claude.ai Gmail"
 * into that spelling; confirmed against the live session's server list, see
 * docs/F4.md.) They are not chosen by anyone here: whatever the account has
 * connected shows up, including services that spend money. So they are denied
 * by default and only the ones named in JARVIS_ACCOUNT_SERVERS run, under the
 * same read/write rules as any other server.
 */
export const ACCOUNT_PREFIX = 'claude_ai_'
export const DEFAULT_ACCOUNT_SERVERS = 'claude_ai_Gmail,claude_ai_Google_Calendar,claude_ai_Google_Drive'
/** Never reachable, with writes on or off, even if it is also in the allowlist. */
export const DEFAULT_BLOCKED_SERVERS = 'claude_ai_Magnific'

/**
 * Anything that says "magnific", in a server name or a tool name, in any
 * spelling and whatever prefix it arrives under. It spends money on its own, so
 * this is a pattern rather than the exact name the CLI happens to use today:
 * `claude.ai Magnific`, `claude_ai_magnific` and a local server called `magnific`
 * are all the same hazard.
 */
const HARD_BLOCK = /magnific/i

/** `claude_ai_Gmail`, `claude.ai Gmail`, `claude-ai Gmail`: one account connector, however spelled. */
const ACCOUNT_RE = /^claude[\W_]*ai[\W_]/i

/** A server name reduced to what compares equal across the spellings above. */
const canon = (s) => String(s).trim().replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()

const csv = (raw, fallback) =>
  new Set(
    (raw ?? fallback)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )

/** Read per call, so a test (or a restart-free edit of the env) is honoured. */
export const accountServers = (env = process.env) => csv(env.JARVIS_ACCOUNT_SERVERS, DEFAULT_ACCOUNT_SERVERS)
/** The built-in blocked servers plus JARVIS_BLOCKED_SERVERS: the variable adds, it never replaces. */
export const blockedServers = (env = process.env) =>
  new Set([...csv(undefined, DEFAULT_BLOCKED_SERVERS), ...csv(env.JARVIS_BLOCKED_SERVERS, '')])

/**
 * `jarvis_core` is judged tool by tool, never by verb. The verb rules read
 * `search_memory` as a lookup (right) but `send_message` as an effect (wrong
 * for a tool that only proposes and is gated by the spoken confirmation in
 * confirm.mjs), and `store_memory` as a write (wrong: it is checked against
 * what the user said, in code). A tool not named here does not run.
 */
const JARVIS_CORE_TOOLS = new Set([
  'search_memory', 'store_memory', 'forget_memory', 'memory_stats', 'ask_local_model',
  'list_channels', 'send_message', 'confirm_send',
])

/**
 * The reminder tools (reminders.mjs) are named for the same reason: `set_reminder`
 * reads as no verb at all and `list_reminders` as a read, and what actually
 * guards them is the user's utterance, checked in code.
 */
const JARVIS_REMINDER_TOOLS = new Set(['set_reminder', 'list_reminders', 'cancel_reminder'])

/**
 * Why a server is refused outright, or null if the name alone does not decide.
 * `tool` is the tool half of the name when the caller has it, so a blocked word
 * in the tool name counts as well.
 */
export function serverRefusal(server, env = process.env, tool = '') {
  if (!server) return null
  if (HARD_BLOCK.test(server) || HARD_BLOCK.test(tool)) return 'blocked'
  const name = canon(server)
  if ([...blockedServers(env)].some((b) => canon(b) === name)) return 'blocked'
  if (ACCOUNT_RE.test(server) && ![...accountServers(env)].some((a) => canon(a) === name)) return 'unlisted'
  return null
}

/** The same, from a full tool name (`mcp__<server>__<tool>`). */
export const toolRefusal = (name, env = process.env) => serverRefusal(mcpServerOf(name), env, mcpToolOf(name))

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: its own name must
 *      begin with a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * allowWrites no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
export const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
])

/**
 * Anchored on the tool name, so it reads the verb rather than the noun.
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers.
 */
const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

export function decideTool(name, allowWrites = false) {
  if (READ_ONLY_BUILTINS.has(name)) return true
  if (WRITE_BUILTINS.has(name)) return allowWrites

  const server = mcpServerOf(name)
  if (server) {
    // First, before anything can say yes: a blocked server, and an account
    // connector nobody listed, are refused in every mode.
    if (toolRefusal(name)) return false

    // The HUD, and the interface controls beside it. Both run in this process
    // and draw on our own screen, so neither is something to withhold —
    // without them JARVIS has no display at all. They also have to be named
    // here rather than left to the verb rules below, which read `ui_theme` as
    // a write and would hold the whole surface back behind allowWrites.
    if (server === 'jarvis' || server === 'jarvis_ui') return true

    // The OpenJarvis link. Tool by tool, on purpose; see JARVIS_CORE_TOOLS.
    if (server === 'jarvis_core') return JARVIS_CORE_TOOLS.has(mcpToolOf(name))
    if (server === 'jarvis_reminders') return JARVIS_REMINDER_TOOLS.has(mcpToolOf(name))

    // The browser server gates itself, at construction: chromeServer() only
    // builds the acting tools — click, type, form input, close tab — when
    // allowWrites is set, so anything that reaches here at all is something
    // the same policy has already permitted. Deciding it a second time by
    // reading verbs out of the name would only get it wrong: `chrome_navigate`
    // begins with no read verb and would fall to the write branch, which would
    // withhold the one tool the whole server is for.
    if (server === 'jarvis_chrome') return true

    // The camera. Not withheld behind allowWrites: looking changes nothing,
    // and the real gate is the browser's own camera permission plus an
    // indicator the user can see for as long as it is live.
    if (server === 'jarvis_eyes') return true

    const tool = mcpToolOf(name)
    if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
      return allowWrites
    }
    // The session tools this bridge is developed inside count as read-only too.
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
    return READ_VERB.test(tool) ? true : allowWrites
  }
  return allowWrites
}


/**
 * The built-in tools the agent is offered at all.
 *
 * Passed as the SDK's `tools` option, which is a different thing from a
 * permission: a tool left out here is not in the model's context, so it can be
 * neither called nor talked into being called. Left to its default the SDK
 * offers the whole Claude Code set — thirty-odd tools, including scheduling
 * cloud agents, sending notifications, spawning subagents and asking questions
 * through a dialog nobody can see on a voice interface. Measured, their schemas
 * are about 10,000 input tokens on every turn, roughly 40% of JARVIS's context.
 *
 * Grep and Glob are named because native builds otherwise search with Bash,
 * which is exactly what read-only mode withholds.
 */
export function builtinTools(allowWrites = false) {
  const reads = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'ToolSearch']
  return allowWrites ? [...reads, 'Bash', 'Write', 'Edit', 'NotebookEdit'] : reads
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** Tools that take a path, and the field it arrives in. */
const PATH_FIELDS = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
}

/**
 * Places that hold credentials, refused even inside an allowed root.
 *
 * Belt and braces: with the default roots none of these is reachable anyway,
 * but JARVIS_FILE_ROOTS can widen the roots to the whole home directory, and a
 * page JARVIS has just read is exactly the thing that would ask for them.
 */
const SECRET_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.claude', '.config/gh', '.config/gcloud']
const SECRET_FILES = /^(\.env(\..*)?|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.claude\.json|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|kdbx))$/i

/**
 * realpath of the deepest part of `p` that exists, with the rest re-attached.
 *
 * A dangling symlink needs following by hand: realpath fails on it, but a
 * write through it still lands at its target, so judging the link's own
 * location would let a Write escape the roots. Null for a link loop.
 */
function resolveReal(p, hops = 0) {
  let head = p
  const tail = []
  for (;;) {
    try {
      return resolvePath(realpathSync(head), ...tail.reverse())
    } catch {
      let link = false
      try {
        link = lstatSync(head).isSymbolicLink()
      } catch {
        /* nothing there at all */
      }
      if (link) {
        if (hops >= 40) return null
        const target = resolvePath(dirname(head), readlinkSync(head))
        return resolveReal(resolvePath(target, ...tail.reverse()), hops + 1)
      }
      const up = dirname(head)
      if (up === head) return p
      tail.push(basename(head))
      head = up
    }
  }
}

const inside = (root, p) => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The directories file tools may touch: the workspace, JARVIS's own temp
 * directory (screenshots and generated media land there) and JARVIS_FILE_ROOTS.
 *
 * Not the system temp directory. `/tmp` holds the scratch space, outputs and
 * logs of every other program running as this user, other Claude Code sessions
 * included, and any of it can carry secrets; "the agent may read /tmp" meant
 * "the agent may read what the rest of the machine left lying around". The
 * agent process is started with TMPDIR pointing at `tmp` instead (server.mjs),
 * so what it writes lands somewhere it may also read.
 */
export function fileRoots({ workspace, tmp, extra = [] }) {
  return [workspace, tmp, ...extra]
    .filter(Boolean)
    .map((root) => {
      try {
        return realpathSync(root)
      } catch {
        return resolvePath(root)
      }
    })
}

/** Why `target` may not be touched, or null if it may. */
export function pathProblem(target, { cwd, roots }) {
  if (typeof target !== 'string' || !target) return null
  const expanded = target.startsWith('~') ? homedir() + target.slice(1) : target
  const real = resolveReal(resolvePath(cwd, expanded))
  if (!real) return `${target} cannot be resolved`
  if (!roots.some((root) => inside(root, real))) {
    return `${target} is outside the folders JARVIS may use`
  }
  const home = realpathSync(homedir())
  if (inside(home, real)) {
    // Lower-cased: on a case-insensitive volume ~/.SSH is ~/.ssh.
    const rel = relative(home, real).split(sep).join('/').toLowerCase()
    if (SECRET_DIRS.some((d) => rel === d || rel.startsWith(d + '/'))) {
      return `${target} holds credentials`
    }
  }
  if (SECRET_FILES.test(basename(real))) return `${target} holds credentials`
  return null
}

// ---------------------------------------------------------------------------
// Browser navigation
// ---------------------------------------------------------------------------

export const NAVIGATE_TOOL = 'mcp__jarvis_chrome__chrome_navigate'
export const KEY_TOOL = 'mcp__jarvis_chrome__chrome_key'
export const TYPE_TOOL = 'mcp__jarvis_chrome__chrome_type'

/**
 * Where the assistant may point the user's own, signed-in Chrome without asking.
 *
 * Navigation is not a read. The page that loads is fetched with the user's
 * cookies, a GET can have side effects, and the address itself carries data to
 * whoever runs the host — so a page that talked the model into "open
 * https://evil.example/?q=<the user's mail>" would leak it with no write tool
 * involved. Hence an allowlist of well-known read-only sites, a cap on the
 * whole address, and a refusal of the open redirectors those sites host.
 *
 * Every entry is one exact host, because a wildcard is a promise about every
 * name under it: `*.github.com` includes gist pages with the attacker's text,
 * `*.youtube.com` and `*.weather.com` include anything a takeover can claim.
 * Entry syntax:
 *
 *   host               that host and every subdomain of it (opt-in, via the env)
 *   =host              that exact host
 *   =host/path         that exact host, and only paths under /path
 *   =host/             that exact host, and only its front page
 *
 * Kept short on purpose. JARVIS_NAV_ALLOW replaces it (comma separated; empty
 * means nothing is allowed without confirmation).
 */
export const DEFAULT_NAV_ALLOW = [
  '=google.com/search', '=www.google.com/search', '=google.com/', '=www.google.com/',
  '=youtube.com', '=www.youtube.com', '=m.youtube.com', '=youtu.be',
  '=wikipedia.org', '=www.wikipedia.org', '=pt.wikipedia.org', '=en.wikipedia.org',
  '=g1.globo.com', '=folha.uol.com.br', '=www.folha.uol.com.br', '=www1.folha.uol.com.br',
  '=bbc.com', '=www.bbc.com', '=bbc.co.uk', '=www.bbc.co.uk',
  '=climatempo.com.br', '=www.climatempo.com.br', '=weather.com', '=www.weather.com',
]

/** Longest query string plus fragment, in characters, a navigation may carry. */
export const MAX_NAV_QUERY = 200

export const navAllowList = (env = process.env) =>
  env.JARVIS_NAV_ALLOW === undefined
    ? DEFAULT_NAV_ALLOW
    : env.JARVIS_NAV_ALLOW.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)

const denyNav = (reason) => ({ allow: false, reason: `Blocked: ${reason}` })

/**
 * May the browser be sent to `raw`?
 *
 *  - back / forward: yes.
 *  - Anything that is not plain http(s) (javascript:, data:, file:, chrome:,
 *    about:, blob:, view-source:…), carries credentials, contains whitespace or
 *    control characters, is longer than 300 characters, or has more than 200
 *    characters of query + fragment: no, in every mode.
 *  - An open redirector (google.com/url?q=…, youtube.com/redirect…): no, in
 *    every mode, even on a listed host.
 *  - A listed host: yes.
 *  - Any other host: no in read-only mode. With writes on, it needs the spoken
 *    confirmation of confirm.mjs, which the bridge itself announces, with the
 *    whole address on the HUD: the first call proposes and is refused; if the
 *    user says the phrase in the very next utterance, the same call goes through.
 */
export function navigationVerdict(raw, { allowWrites = false, gate, navAllow = navAllowList() } = {}) {
  const text = String(raw ?? '').trim()
  if (/^(back|forward)$/i.test(text)) return { allow: true }
  if (!text) return denyNav('no address was given.')
  if (/[\u0000- \u007f-\u009f]/.test(text)) return denyNav('that address contains spaces or control characters.')

  // "exemplo.com" and "localhost:3000" have no scheme; anything else that
  // starts with `name:` does, and only http(s) is acceptable.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z0-9.-]+:\d+(\/|\?|#|$)/i.test(text)
  let url
  try {
    url = new URL(hasScheme ? text : `https://${text}`)
  } catch {
    return denyNav('that is not a valid address.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return denyNav(`${url.protocol.replace(':', '')}: addresses cannot be opened.`)
  }
  if (url.username || url.password) return denyNav('addresses with a login in them cannot be opened.')
  if (text.length > MAX_EGRESS_URL || url.href.length > MAX_EGRESS_URL) {
    return denyNav(`the address is longer than ${MAX_EGRESS_URL} characters.`)
  }

  // Measured on the parsed form and on what was typed, whichever is longer.
  const rawTail = text.slice(Math.min(...[text.indexOf('?'), text.indexOf('#')].filter((i) => i >= 0), text.length))
  if (Math.max(url.search.length + url.hash.length, rawTail.length) > MAX_NAV_QUERY) {
    return denyNav(`the address carries more than ${MAX_NAV_QUERY} characters after the path.`)
  }
  if (isRedirector(url)) return denyNav('that address is a redirector, which can lead anywhere.')

  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (navAllowed(host, url.pathname, navAllow)) return { allow: true }

  if (!allowWrites) {
    return denyNav(
      `${host} is not one of the sites JARVIS may open in read-only mode.` +
        ' Tell the user it is unavailable until write access is enabled on the machine.',
    )
  }
  if (!gate) return denyNav(`${host} is not on the list of sites JARVIS may open.`)

  const target = url.href
  const pending = gate.find('nav', (d) => d.url === target)
  if (!pending) {
    // The bridge reads the address aloud as part of its announcement. One that
    // says "pode abrir" when read out (a path like /pode-abrir) would put the
    // yes in the speaker's own mouth.
    if (hasConfirmationPhrase(announcedText('nav', { url: target }))) {
      return denyNav('that address contains a phrase the system uses to confirm actions, so it cannot be read out for confirmation.')
    }
    gate.propose('nav', { url: target })
    return denyNav(
      `${host} is not on the list of sites JARVIS opens by itself, so it needs the user's spoken confirmation.` +
        ' The system will now announce the address to the user and wait for their answer. Do not say the address,' +
        ' do not ask anything and do not repeat the call in this turn. Finish your answer.' +
        ' If the next thing the user says is a confirmation, call this tool again with the same address.',
    )
  }
  const verdict = gate.confirm('nav', (d) => d.url === target)
  if (verdict.ok) return { allow: true }
  return denyNav(`${host} still needs the user's spoken confirmation. ${verdict.reason}`)
}

/**
 * Where did the tab land? The page may have been sent on by a redirect the
 * request did not show, and a listed host that forwards to somewhere else is
 * the open-redirect hole by another door. Judged after the page has loaded:
 * the final host must be on the list, or be the very host that was asked for
 * (a spoken confirmation covers that host and no other).
 */
export function navigationFinalProblem(finalUrl, requestedUrl, { navAllow = navAllowList() } = {}) {
  let final
  let asked
  try {
    final = new URL(finalUrl)
    asked = new URL(/^[a-z][a-z0-9+.-]*:/i.test(requestedUrl) ? requestedUrl : `https://${requestedUrl}`)
  } catch {
    return null // nothing readable to judge
  }
  if (final.protocol !== 'http:' && final.protocol !== 'https:') return 'the page ended on something that is not a website'
  const host = final.hostname.toLowerCase().replace(/\.$/, '')
  const askedHost = asked.hostname.toLowerCase().replace(/\.$/, '')
  if (isRedirector(final)) return 'the page ended on a redirector'
  if (host === askedHost || navAllowed(host, final.pathname, navAllow)) {
    return null
  }
  return `the site sent the browser on to ${host}, which is not one of the allowed sites`
}

// ---------------------------------------------------------------------------
// Browser keys, typing, clicking
// ---------------------------------------------------------------------------

/**
 * With writes on, `chrome_key` and `chrome_type` could do what `chrome_navigate`
 * refuses to: focus the address bar (ctrl+L, alt+D, F6, or a fresh tab) and type
 * an address and Enter. So a chord is allowed only if it is on a short list of
 * things that act on the page itself, and typing that looks like an address is
 * refused. (A list of what is blocked is a list of what someone thought of: it
 * let `alt+f`, `alt+e`, `ctrl + l` and `F10` through.)
 */
const MODIFIER = { ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl', cmd: 'meta', command: 'meta', meta: 'meta', super: 'meta', win: 'meta', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift' }
/** With ctrl or cmd: select all, copy, cut, paste, undo, redo, reload. */
const CTRL_LETTERS = new Set('acvxzyr'.split(''))
/** Keys that move within the page or its fields, with or without ctrl/cmd/shift. */
const NAV_KEYS = new Set(['home', 'end', 'left', 'right', 'up', 'down', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'pageup', 'pagedown', 'backspace', 'delete'])
const SELECT_KEYS = new Set(['home', 'end', 'left', 'right', 'up', 'down', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'pageup', 'pagedown'])
/** With ctrl/cmd, of the plain keys only these: the others (tab, escape) can switch tab or leave the page. */
const CTRL_ENTRY_KEYS = new Set(['return', 'enter', 'space'])
const KEY_REFUSAL = 'that key or chord can reach the browser itself, not just the page'

export function keyProblem(text) {
  // NFKC so that full-width and compatibility forms read as what they look like;
  // spaces around a "+" are not separators ("ctrl + l" is one chord).
  const norm = String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s*\+\s*/g, '+').trim()
  for (const chord of norm.split(/\s+/).filter(Boolean)) {
    const parts = chord.split('+').filter(Boolean)
    const mods = new Set()
    const keys = []
    for (const part of parts) {
      if (MODIFIER[part] && parts.length > 1) mods.add(MODIFIER[part])
      else keys.push(part)
    }
    if (keys.length > 1) return KEY_REFUSAL
    const key = keys[0] ?? ''
    if (/^f\d{1,2}$/.test(key) && key !== 'f5') return KEY_REFUSAL
    if (mods.has('alt')) {
      // Alt+Left and Alt+Right are back and forward; every other alt chord opens a menu or the address bar.
      if (mods.size === 1 && /^(left|right|arrowleft|arrowright)$/.test(key)) continue
      return KEY_REFUSAL
    }
    if (mods.has('ctrl') || mods.has('meta')) {
      const ok = mods.has('shift')
        ? SELECT_KEYS.has(key) || key === 'z'
        : CTRL_LETTERS.has(key) || NAV_KEYS.has(key) || CTRL_ENTRY_KEYS.has(key) || key === 'f5'
      if (!ok) return KEY_REFUSAL
    }
  }
  return null
}

/** Does this one word read as an address: a host with a dot and a letters-only ending, an IP, localhost? */
const HOSTISH = /^(?:[\w-]+(?:\.[\w-]+)*\.[a-z]{2,24}|(?:\d{1,3}\.){3}\d{1,3}|localhost)(?=[/?#:]|$)/i

export function typeProblem(text) {
  const t = String(text ?? '').normalize('NFKC').trim()
  if (/^(javascript|data|file|chrome|about|view-source|vbscript|blob):/i.test(t)) return 'that is not text to type into a page'
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(t) || /(^|[\s/])www\./i.test(t) || t.startsWith('//')) {
    return 'typing an address is not allowed; use the navigation tool'
  }
  // Typed into the address bar, "evil.com?d=x" or "att.museum/x" is a navigation as much as a URL with a scheme is.
  const words = t.split(/\s+/)
  if (HOSTISH.test(words[0]) || HOSTISH.test(words.at(-1) ?? '')) return 'typing an address is not allowed; use the navigation tool'
  return null
}

/** The most characters of typed or form text that can be read out for a confirmation. */
export const MAX_ACTION_TEXT = 300

export const CLICK_TOOL = 'mcp__jarvis_chrome__chrome_click'
export const FORM_TOOL = 'mcp__jarvis_chrome__chrome_form_input'

/** The words the model gives for what a click does, cleaned to something that can be read aloud. */
function whySaid(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return neutraliseConfirmation(cleaned)
}

/**
 * What a gated browser action is, as the data the gate stores and compares, or a
 * reason it cannot be proposed at all. Click is compared on the element it
 * names, never on the `why` (the repeat of a confirmed call need not say it again).
 */
function actionOf(name, input) {
  if (name === CLICK_TOOL) {
    const ref = typeof input?.ref === 'string' ? input.ref.trim().slice(0, 60) : ''
    const coordinate = Array.isArray(input?.coordinate)
      ? input.coordinate.slice(0, 2).map((n) => Math.round(Number(n)))
      : []
    if (!ref && (coordinate.length !== 2 || coordinate.some((n) => !Number.isFinite(n)))) {
      return { problem: 'a click needs a ref from chrome_read_page, or a coordinate' }
    }
    return { kind: 'click', data: { ref, coordinate: ref ? [] : coordinate, why: whySaid(input?.why) }, same: (d) => d.ref === ref && d.coordinate.join() === (ref ? [] : coordinate).join() }
  }
  if (name === TYPE_TOOL) {
    const text = String(input?.text ?? '')
    if (!text.trim()) return { problem: 'there is no text to type' }
    if (text.length > MAX_ACTION_TEXT) return { problem: `the text is longer than ${MAX_ACTION_TEXT} characters, too long to read out for confirmation` }
    return { kind: 'type', data: { text }, same: (d) => d.text === text }
  }
  const ref = typeof input?.ref === 'string' ? input.ref.trim().slice(0, 60) : ''
  const value = String(input?.value ?? '')
  if (!ref) return { problem: 'a form field needs its ref from chrome_read_page' }
  if (value.length > MAX_ACTION_TEXT) return { problem: `the value is longer than ${MAX_ACTION_TEXT} characters, too long to read out for confirmation` }
  return { kind: 'form', data: { ref, value }, same: (d) => d.ref === ref && d.value === value }
}

/**
 * Click, type and fill a field act on the user's signed-in browser, so with
 * writes on each one needs the spoken confirmation, with its own phrase
 * ("pode clicar", "pode digitar", "pode preencher"): the first call proposes and
 * is refused, the bridge announces it with everything that would be done, and
 * the same call goes through only if the very next utterance is the phrase.
 * Same mechanism as opening an address outside the list (navigationVerdict).
 */
function gatedActionVerdict(name, input, gate) {
  const action = actionOf(name, input)
  if (action.problem) return denyNav(`${action.problem}.`)
  // The announcement is read aloud by the bridge; text that itself says "pode
  // clicar" would put the yes in the speaker's mouth.
  if (hasConfirmationPhrase(announcedText(action.kind, action.data))) {
    return denyNav('that text contains a phrase the system uses to confirm actions, so it cannot be read out for confirmation. Say it differently.')
  }
  if (!gate) return denyNav('this action needs the spoken confirmation, and none is available.')
  const pending = gate.find(action.kind, action.same)
  if (!pending) {
    gate.propose(action.kind, action.data)
    return denyNav(
      "this acts on the user's own browser, so it needs the user's spoken confirmation." +
        ' The system will now announce exactly what it would do and wait for their answer. Do not say it yourself,' +
        ' do not ask anything and do not repeat the call in this turn. Finish your answer.' +
        ' If the next thing the user says is the confirmation, call this tool again with the same arguments.',
    )
  }
  const verdict = gate.confirm(action.kind, action.same)
  if (verdict.ok) return { allow: true }
  return denyNav(`this still needs the user's spoken confirmation. ${verdict.reason}`)
}

/**
 * The full decision for one call: name first, then arguments.
 *
 * Returns { allow: true } or { allow: false, reason }. The reason can end up
 * spoken, so it is a plain sentence with no paths or commands to read out
 * beyond the one the model already chose.
 */
export function checkToolUse(name, input, { allowWrites = false, cwd, roots, gate, navAllow, egress }) {
  const refusal = toolRefusal(name)
  if (refusal === 'blocked') {
    return {
      allow: false,
      reason:
        'Blocked: this tool is permanently disabled on this assistant, whatever the mode.' +
        ' Tell the user it is unavailable and do not look for another way to do it.',
    }
  }
  if (refusal === 'unlisted') {
    return {
      allow: false,
      reason:
        'Blocked: this account connector is not on the list of services this assistant may use.' +
        ' Tell the user it is unavailable.',
    }
  }
  if (!decideTool(name, allowWrites)) {
    return {
      allow: false,
      reason:
        'Blocked: JARVIS is running in read-only mode and cannot take actions' +
        ' that change anything. Tell the user this action is unavailable' +
        ' until they enable write access on the machine.',
    }
  }
  if (name === NAVIGATE_TOOL) {
    const verdict = navigationVerdict(input?.url, { allowWrites, gate, navAllow })
    if (!verdict.allow) return verdict
  }
  if (name === KEY_TOOL) {
    const problem = keyProblem(input?.text)
    if (problem) return { allow: false, reason: `Blocked: ${problem}. Use the navigation tool to open a site.` }
  }
  if (name === TYPE_TOOL) {
    const problem = typeProblem(input?.text)
    if (problem) return { allow: false, reason: `Blocked: ${problem}.` }
  }
  if (name === CLICK_TOOL || name === TYPE_TOOL || name === FORM_TOOL) {
    const verdict = gatedActionVerdict(name, input, gate)
    if (!verdict.allow) return verdict
  }
  for (const field of PATH_FIELDS[name] ?? []) {
    const problem = pathProblem(input?.[field], { cwd, roots })
    if (problem) return { allow: false, reason: `Blocked: ${problem}.` }
  }
  if (name === 'WebFetch') {
    // The bridge's own fetches refuse the LAN and cloud metadata; the built-in
    // fetch runs in the agent process and has no such gate, so apply the same
    // one to the URL before it goes.
    try {
      vetTarget(input?.url)
    } catch (err) {
      return { allow: false, reason: `Blocked: that address cannot be fetched (${err.message}).` }
    }
    // And the one rule every outbound address answers to (egress.mjs): not too
    // long, and, once this session has read private data, only an address the
    // model was handed rather than one it composed.
    const problem = egress ? egress.check(input?.url) : egressProblem(input?.url, { allow: [] })
    if (problem) return { allow: false, reason: `Blocked: ${problem}. Say the address cannot be opened and use a web search instead.` }
  }
  return { allow: true }
}

/**
 * Where a WebFetch hostname actually points, or null if it is public.
 *
 * checkToolUse only sees the URL's text, so a public name that resolves to
 * 127.0.0.1 or a LAN address passes it. This resolves the name and applies the
 * same address rules as the bridge's own fetches. It cannot pin the address
 * the CLI then connects to, so a name that rebinds between the two lookups is
 * still possible; it closes the static case. `resolve` is injectable for tests.
 */
export async function fetchTargetProblem(url, resolve = lookup) {
  let host
  try {
    host = vetTarget(url).hostname.replace(/^\[|\]$/g, '')
  } catch (err) {
    return err.message
  }
  if (isIP(host)) return null // literals were judged by vetTarget
  let answers
  try {
    answers = await resolve(host, { all: true })
  } catch {
    return null // unresolvable: the fetch fails on its own
  }
  const bad = answers.find((a) => blockedAddress(a.address))
  return bad ? `${host} resolves to the private address ${bad.address}` : null
}

/**
 * The PreToolUse hook: the enforcement point. It runs before every tool call,
 * including the ones the CLI would otherwise approve on its own without
 * consulting canUseTool (see the measurement at the top of this file).
 *
 * Fails closed. A check that throws, or a DNS lookup that never answers, is a
 * refusal of that call, never a pass: an unexpected error here must not turn
 * into "allowed".
 *
 * @param {{
 *   allowWrites: boolean, cwd: string, roots: string[], gate?: object, egress: object,
 *   fetchProblem?: (url: string) => Promise<string | null>,
 *   timeoutMs?: number,
 *   log?: (line: string) => void,
 * }} deps
 */
export function createPolicyHook({
  allowWrites, cwd, roots, gate, egress, fetchProblem = fetchTargetProblem, timeoutMs = 3_000, log = console.log,
}) {
  return async (input) => {
    let reason = null
    try {
      const verdict = checkToolUse(input.tool_name, input.tool_input, { allowWrites, cwd, roots, gate, egress })
      reason = verdict.allow ? null : verdict.reason
      if (!reason && input.tool_name === 'WebFetch') {
        let timer
        const problem = await Promise.race([
          fetchProblem(input.tool_input?.url),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve('the address check timed out'), timeoutMs)
          }),
        ]).finally(() => clearTimeout(timer))
        if (problem) reason = `Blocked: that address cannot be fetched (${problem}).`
      }
      if (!reason) {
        // The call will run, so what it returns may be private, and what it
        // returns may be hostile. Remember both (egress.mjs).
        egress.onToolUse(input.tool_name)
      }
      // Whatever the verdict, the addresses in this call's input are ones the
      // model wrote. Recorded after the check, so an address it was handed
      // (and is now using) is not reclassified by being used.
      egress.noteInput?.(input.tool_name, input.tool_input)
    } catch (err) {
      log(`[jarvis] policy check failed, refusing the call: ${err?.message ?? err}`)
      reason = 'Blocked: the policy check could not be completed. Tell the user this action is unavailable.'
    }
    if (!reason) return {}
    log(`[jarvis] tool ${input.tool_name} -> deny (policy)`)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }
  }
}
