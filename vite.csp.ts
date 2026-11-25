/**
 * What the page's Content-Security-Policy is filled in with (see index.html).
 * Plain functions, no Vite import, so they can be tested on their own.
 */

export const DEFAULT_BRIDGE_URL = 'ws://localhost:8787'

/**
 * A bridge address is accepted only if it is exactly scheme://host[:port][/].
 * The value ends up inside a CSP header, where a `;` starts a new directive and
 * a space starts a new source, so anything looser than this (credentials, a
 * path, quotes, a second URL, a stray `;`) is refused rather than escaped.
 */
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const BRIDGE_URL = new RegExp(
  `^(wss?|https?)://(localhost|127\\.0\\.0\\.1|\\[::1\\]|${LABEL}(?:\\.${LABEL})*)(?::(\\d{1,5}))?/?$`,
)

export type BridgeOrigins = { http: string[]; ws: string[]; warning?: string }

/** The origins the page may frame, load media from and connect to for `raw`. */
export function bridgeOrigins(raw: string | undefined): BridgeOrigins {
  const text = (raw ?? '').trim() || DEFAULT_BRIDGE_URL
  let m = BRIDGE_URL.exec(text)
  let warning: string | undefined
  const port = m?.[3] === undefined ? undefined : Number(m[3])
  if (!m || (port !== undefined && (port < 1 || port > 65535))) {
    warning = `VITE_BRIDGE_URL is not a plain ws://host:port address; using ${DEFAULT_BRIDGE_URL} for the page policy.`
    m = BRIDGE_URL.exec(DEFAULT_BRIDGE_URL)!
  }
  const secure = m[1] === 'wss' || m[1] === 'https'
  const suffix = m[3] ? `:${m[3]}` : ''
  const hosts = [...new Set(['localhost', '127.0.0.1', m[2]])]
  return {
    http: hosts.map((h) => `${secure ? 'https' : 'http'}://${h}${suffix}`),
    ws: hosts.map((h) => `${secure ? 'wss' : 'ws'}://${h}${suffix}`),
    warning,
  }
}

/**
 * The few remote hosts the page itself talks to, beyond the bridge and itself.
 *
 *  - Nothing for the MediaPipe runtime or its models (hand landmarks, YAMNet):
 *    scripts/start.mjs vendors them, pinned by SHA-256, and the page loads them
 *    from its own origin. (The hand model used to need storage.googleapis.com,
 *    which allowed a request to any bucket on that host.)
 *  - VITE_BACKEND=direct: the browser calls Anthropic itself.
 *  - VITE_ELEVENLABS_API_KEY: a key in the browser lets src/lib/tts.ts call
 *    ElevenLabs directly when the bridge cannot speak. (Without it the voice
 *    and transcription go through the bridge.)
 *  - VITE_TTS_ENGINE=kokoro: the neural voice downloads its model from Hugging Face.
 *
 * Everything else goes through the bridge, which is the point of keeping this
 * list short: a page that can connect anywhere can report anything anywhere.
 */
/**
 * What `script-src` gets beyond 'self', 'wasm-unsafe-eval' and blob: workers.
 *
 *  - 'unsafe-inline' only in dev: Vite injects the React Fast Refresh preamble as
 *    an inline module script. The built page has none (a test checks it), so the
 *    build does not allow inline script at all.
 *  - 'unsafe-eval' only with the in-browser neural voice (VITE_TTS_ENGINE=kokoro):
 *    the ONNX runtime and the inline espeak-ng WASM need it. Nothing else does.
 */
export function scriptSources(opts: { dev: boolean; ttsEngine?: string }): string[] {
  const out: string[] = []
  if (opts.dev) out.push("'unsafe-inline'")
  if (opts.ttsEngine === 'kokoro') out.push("'unsafe-eval'")
  return out
}

export function extraConnectSources(opts: {
  backend?: string
  ttsEngine?: string
  elevenKey?: string
}): string[] {
  const hosts: string[] = []
  if (opts.backend === 'direct') hosts.push('https://api.anthropic.com')
  if (opts.elevenKey) hosts.push('https://api.elevenlabs.io')
  if (opts.ttsEngine === 'kokoro')
    hosts.push('https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co')
  return hosts
}
