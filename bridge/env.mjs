/**
 * The environment a child process is allowed to inherit.
 *
 * The agent is the Claude Code CLI, started by the SDK, and unless it is given
 * an `env` it inherits everything the bridge has: the OpenJarvis key, the
 * ElevenLabs key, whatever else was in ~/.config/jarvis/env or in the shell that
 * started it. With writes on the agent has a shell, and `printenv` is one
 * command away from a page's text. The bridge needs those secrets itself (they
 * are used here, in process); the child does not.
 *
 * An ALLOWLIST, not a filter. The first version dropped names that looked like
 * credentials (`*_KEY`, `*_TOKEN`…) and let everything else through, and a
 * review found what that misses: `OPENAI_APIKEY`, `DATABASE_URL`, `GITHUB_PAT`,
 * `SENTRY_DSN`, `MY_PWD`, `DBUS_SESSION_BUS_ADDRESS` and `GNOME_KEYRING_CONTROL`
 * (a way to the desktop keyring, and through it to the browser's cookies),
 * `SSH_AUTH_SOCK` and the `CLAUDE_CODE_*` session variables of whatever Claude
 * Code session happened to start the bridge. A name that nobody listed does not
 * pass, whatever it is called.
 *
 * What the CLI needs was measured, not guessed (docs/SEGURANCA.md, N7): with
 * only the names below it starts, authenticates with the login stored in
 * `~/.claude/.credentials.json`, runs the in-process MCP servers, and answers. The
 * Anthropic variables are the ones it documents for choosing an account, an
 * endpoint or a model; they are kept because without them an API-key setup
 * cannot start, which leaves them readable by a shell the agent runs, one more
 * reason `--writes` is not for a microphone that is open to the room. Anything
 * else a particular setup needs (a cloud provider's credentials, say) is named in
 * `JARVIS_CHILD_ENV`, comma separated, on purpose and by name.
 */

/** What any program needs to run, find its files and print in the right language. */
const BASICS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
]

/** Network plumbing: a proxy, and certificates for a proxy that re-signs traffic. */
const NETWORK = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]

/** How the Claude Code CLI is told which account, endpoint and model to use. */
const CLAUDE = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BETAS',
  'ANTHROPIC_CONFIG_DIR', 'ANTHROPIC_PROFILE', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'CLOUD_ML_REGION',
]

/** Never passed, even if JARVIS_CHILD_ENV names them. The bridge's own secrets. */
const NEVER = new Set([
  'OPENJARVIS_API_KEY', 'ELEVENLABS_API_KEY', 'JARVIS_BRIDGE_TOKEN', 'VITE_BRIDGE_TOKEN', 'JARVIS_ANNOUNCE_TOKEN',
])

const namesOf = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))

/** Copy the allowed names (and the allowed prefixes) of `env`, then `extra`. */
function pick(env, { names, prefixes = [], extra = {} }) {
  const allowed = new Set([...names, ...namesOf(env.JARVIS_CHILD_ENV)])
  const out = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || NEVER.has(name)) continue
    if (allowed.has(name) || prefixes.some((p) => name.startsWith(p))) out[name] = value
  }
  return { ...out, ...extra }
}

/** The agent's (the Claude Code CLI's) environment. `extra` is set on top: its own temp folder, say. */
export function safeEnv(env = process.env, extra = {}) {
  return pick(env, { names: [...BASICS, ...NETWORK, ...CLAUDE], prefixes: ['LC_'], extra })
}

/**
 * The face's (the Vite dev server's) environment. It serves files to a browser and
 * has no use for any key the bridge holds, but it does read `PORT`, `NODE_ENV` and
 * the `VITE_*` variables that are meant for the page. The per-start bridge token is
 * handed over through `extra`, not inherited.
 */
export function faceEnv(env = process.env, extra = {}) {
  return pick(env, {
    names: [...BASICS, ...NETWORK, 'PORT', 'NODE_ENV', 'NODE_OPTIONS', 'FORCE_COLOR', 'NO_COLOR', 'CI'],
    prefixes: ['LC_', 'VITE_'],
    extra,
  })
}
