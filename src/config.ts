import { ASSISTANT_NAME } from './lib/identity'

/**
 * JARVIS configuration.
 *
 * Everything here is read from Vite env vars (.env.local) so no secrets are
 * committed. See .env.example for the full list.
 */

/**
 * Vite inlines a blank `.env` entry as an empty string, not as undefined, so
 * `??` never falls through to the default — and .env.example ships every
 * optional key blank, which is exactly the shape that used to bite. A blank
 * VITE_BACKEND silently selected the direct path and then complained about a
 * missing API key. Treat whitespace-only as unset everywhere in this file.
 */
function str(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value === '' ? undefined : value
}

/**
 * Fixed-choice options. An unrecognised value is nearly always a typo, and
 * quietly falling back to the default hides it until it costs you a take.
 */
function choice<T extends string>(
  name: string,
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = str(raw)
  if (value === undefined) return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  console.warn(
    `[jarvis] ${name}="${value}" is not one of ${allowed.join(' | ')} — using "${fallback}".`,
  )
  return fallback
}

/** Same, for the on/off options. Accepts true/false and 1/0. */
function flag(name: string, raw: unknown, fallback: boolean): boolean {
  const value = str(raw)?.toLowerCase()
  if (value === undefined) return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  console.warn(`[jarvis] ${name}="${value}" is not true or false — using ${fallback}.`)
  return fallback
}

/** A number in a range; blank means the default, junk or out of range warns and uses it. */
function num(name: string, raw: unknown, fallback: number, min: number, max: number): number {
  const value = str(raw)
  if (value === undefined) return fallback
  const n = Number(value)
  if (Number.isFinite(n) && n >= min && n <= max) return n
  console.warn(`[jarvis] ${name}="${value}" is not a number from ${min} to ${max} — using ${fallback}.`)
  return fallback
}

/**
 * Wake by double clap or double finger snap, next to the voice wake word.
 * See docs/PALMAS.md. None of these is a secret; all are optional.
 *
 *   VITE_CLAP_WAKE         on | off. Default on.
 *   VITE_CLAP_KINDS        which sounds count: clap, snap or clap,snap. Default both.
 *   VITE_CLAP_SENSITIVITY  YAMNet score a sound needs, 0.05 to 0.95. Default 0.35:
 *                          below this the model is guessing; a deliberate clap
 *                          or snap scores well above it. Lower hears more
 *                          (and mistakes more), higher wants a clearer sound.
 *   VITE_CLAP_WINDOW_MS    longest gap between the two sounds, 300 to 1500.
 *                          Default 600. (They also have to be at least 150 ms
 *                          apart, or it is one sound.)
 */
export const CLAP_WAKE = choice('VITE_CLAP_WAKE', import.meta.env.VITE_CLAP_WAKE, ['on', 'off'] as const, 'on') === 'on'
export const CLAP_KINDS_RAW = str(import.meta.env.VITE_CLAP_KINDS)
export const CLAP_SENSITIVITY = num('VITE_CLAP_SENSITIVITY', import.meta.env.VITE_CLAP_SENSITIVITY, 0.35, 0.05, 0.95)
export const CLAP_WINDOW_MS = num('VITE_CLAP_WINDOW_MS', import.meta.env.VITE_CLAP_WINDOW_MS, 600, 300, 1500)

/**
 * Which brain to use.
 *
 *   'bridge' — run `npm run bridge` alongside the app. Authenticates off your
 *              existing Claude Code login (no API key), and every MCP server in
 *              your Claude Code config is available to JARVIS, including local
 *              ones like higgsfield, elevenlabs, android and playwright.
 *
 *   'direct' — the browser calls the Claude API itself. Nothing to run and it
 *              deploys as a static site, but it needs VITE_ANTHROPIC_API_KEY in
 *              the bundle and only reaches remote HTTP MCP servers.
 */
export const BACKEND: 'bridge' | 'direct' = choice(
  'VITE_BACKEND',
  import.meta.env.VITE_BACKEND,
  ['bridge', 'direct'] as const,
  'bridge',
)

/**
 * Where the bridge lives. Derived once here rather than in each of the three
 * places that talk to it, so moving off the default port is a single edit.
 * `wss://` maps to `https://` on its own, which is why this is a prefix swap
 * rather than a hardcoded scheme.
 */
export const BRIDGE_WS_URL = str(import.meta.env.VITE_BRIDGE_URL) ?? 'ws://localhost:8787'
export const BRIDGE_HTTP_URL = BRIDGE_WS_URL.replace(/^ws/, 'http')

/**
 * The per-start token the bridge asks for (bridge/server.mjs, docs/SEGURANCA.md).
 * `npm start` generates one and gives the same value to both halves. It is not a
 * secret from this browser: it is handed to the page. What it keeps out is every
 * other site and program that can merely reach localhost.
 *
 * Two ways it arrives. In development Vite inlines `VITE_BRIDGE_TOKEN`. In the
 * built face (the production way, docs/SEGURANCA.md) nothing is baked in: the
 * static server (scripts/serve.mjs) answers `/jarvis-config.js` with the token of
 * that run, which sets `__JARVIS__` before this module loads. Blank when the
 * bridge was started alone, in which case the bridge does not ask for one.
 */
const served = (globalThis as { __JARVIS__?: { token?: unknown } }).__JARVIS__?.token
export const BRIDGE_TOKEN = str(import.meta.env.VITE_BRIDGE_TOKEN) ?? (typeof served === 'string' ? served : '')

/** `&t=…` to append to a bridge URL that already has a query string. */
export const BRIDGE_AUTH = BRIDGE_TOKEN ? `&t=${encodeURIComponent(BRIDGE_TOKEN)}` : ''

/** `?t=…` for a bridge URL that has none (`/tts`, `/stt`). */
export const BRIDGE_AUTH_FIRST = BRIDGE_TOKEN ? `?t=${encodeURIComponent(BRIDGE_TOKEN)}` : ''

/**
 * Speech output engine.
 *
 * false (default) — the browser's own speechSynthesis. Runs on-device, so
 *   speech starts on the next frame with no request and no download. This is
 *   the fastest option that exists and it's why it's the default.
 *
 * true — ElevenLabs. Noticeably better voice, but every sentence costs a
 *   round trip plus generation, which is the difference between a conversation
 *   and a walkie-talkie. Turn it on when you want the voice more than the pace.
 */
export const USE_ELEVENLABS = flag(
  'VITE_USE_ELEVENLABS',
  import.meta.env.VITE_USE_ELEVENLABS,
  false,
)

/**
 * Speech engine.
 *
 *   'system' — the browser's own speechSynthesis. Starts on the next frame,
 *     costs nothing, but is capped by whatever voices the OS ships; on macOS
 *     the British male option is compact Daniel.
 *
 *   'kokoro' — an 82M-parameter neural TTS running entirely in the browser via
 *     ONNX. Four proper British male voices and far better sound, nothing
 *     leaving the machine. MEASURED ON THIS MACHINE at q8/WebGPU it generates
 *     about 2.2x slower than realtime — "Yes, sir?" took 3.3 seconds and a
 *     thirteen-word sentence took nine. That is not a conversation, so it is
 *     not the default. Try `fp32` (see kokoro.ts) before enabling it; int8
 *     quantisation often silently falls back to CPU on WebGPU, which is the
 *     likely cause.
 */
export const TTS_ENGINE: 'kokoro' | 'system' = choice(
  'VITE_TTS_ENGINE',
  import.meta.env.VITE_TTS_ENGINE,
  ['kokoro', 'system'] as const,
  'system',
)

/**
 * Which Kokoro voice. All four are British male:
 *   bm_george — measured RP baritone, closest to the character
 *   bm_fable  — warmer
 *   bm_lewis  — lower
 *   bm_daniel — brighter
 */
export const KOKORO_VOICE = choice(
  'VITE_KOKORO_VOICE',
  import.meta.env.VITE_KOKORO_VOICE,
  ['bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'] as const,
  'bm_george',
)

export const env = {
  anthropicKey: str(import.meta.env.VITE_ANTHROPIC_API_KEY) ?? '',
  elevenKey: str(import.meta.env.VITE_ELEVENLABS_API_KEY) ?? '',
  elevenVoiceId:
    str(import.meta.env.VITE_ELEVENLABS_VOICE_ID) ?? 'JBFqnCBsd6RMkjVDRZzb',
  porcupineKey: str(import.meta.env.VITE_PICOVOICE_ACCESS_KEY) ?? '',
}

/** `claude-opus-5` is the strongest model; `claude-sonnet-5` trades a little
 *  quality for lower latency if you find responses feel slow on camera. */
export const MODEL = 'claude-opus-5'

/**
 * Fast mode runs the same Opus 5 at up to 2.5x output speed. It is a research
 * preview on the Claude API and costs $10/$50 per Mtok instead of $5/$25.
 * For a recorded demo the snappiness is worth it; flip to false to save money.
 */
export const FAST_MODE = true

/**
 * Wake-word engine.
 *   'speech'    — zero setup, uses the browser's SpeechRecognition to listen for
 *                 "hey jarvis". Chrome/Edge only, audio goes to Google.
 *   'porcupine' — recommended. Runs offline in WASM, "Jarvis" is a built-in
 *                 keyword, far fewer false triggers. Needs a free AccessKey
 *                 from console.picovoice.ai.
 */
export const WAKE_ENGINE: 'speech' | 'porcupine' = env.porcupineKey
  ? 'porcupine'
  : 'speech'

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export type McpServer = {
  /** Stable id used as the tool namespace. Lowercase, no spaces. */
  name: string
  /** Human label for the HUD. */
  label: string
  /** Remote MCP endpoint. Must be reachable from Anthropic's servers, not yours. */
  url: string
  /** Bearer token, if the server wants one. Many put the secret in the URL instead. */
  token?: string
  enabled: boolean
}

/**
 * These are passed to the Messages API `mcp_servers` parameter. Anthropic dials
 * the servers itself, so there is no CORS to fight and no local bridge to run —
 * which is what makes a backend-free JARVIS possible.
 *
 * Only *remote HTTP* MCP servers work here. Local stdio servers (filesystem,
 * Blender, Playwright) need a machine to run on and are out of scope for a
 * browser-only build.
 *
 * READ THIS BEFORE FILLING ANY OF THESE IN. Every one of them ships to the
 * browser. In direct mode Vite inlines each token below into the JavaScript
 * bundle, and the Zapier and Pipedream URLs *are* secrets — the URL is the
 * credential. Anyone who opens devtools on a deployed build gets your Notion,
 * Linear, GitHub, Stripe, Sentry and Home Assistant access, not just the
 * Anthropic key. This is fine for a demo on your own machine or a recording;
 * it is not fine for anything public. The bridge backend (the default) reads
 * none of this — it uses your Claude Code MCP config, where the secrets stay on
 * your machine — so if you want these integrations without the exposure, run
 * `npm run bridge` instead of filling in this block.
 */
export const MCP_SERVERS: McpServer[] = [
  // The single highest-leverage integration: one URL, ~8,000 apps, managed
  // OAuth. Wire up Gmail, Google Calendar, Spotify, Slack, Notion and Sheets in
  // the Zapier dashboard and they all arrive through this one endpoint.
  // Get yours at https://mcp.zapier.com -> New MCP Server.
  {
    name: 'zapier',
    label: 'Zapier',
    url: str(import.meta.env.VITE_ZAPIER_MCP_URL) ?? '',
    enabled: Boolean(str(import.meta.env.VITE_ZAPIER_MCP_URL)),
  },

  // Alternative/complementary gateway: ~3,000 apps, free for personal use.
  {
    name: 'pipedream',
    label: 'Pipedream',
    url: str(import.meta.env.VITE_PIPEDREAM_MCP_URL) ?? '',
    enabled: Boolean(str(import.meta.env.VITE_PIPEDREAM_MCP_URL)),
  },

  // Official first-party servers. Each needs its own OAuth token pasted in.
  {
    name: 'notion',
    label: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    token: str(import.meta.env.VITE_NOTION_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_NOTION_TOKEN)),
  },
  {
    name: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    token: str(import.meta.env.VITE_LINEAR_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_LINEAR_TOKEN)),
  },
  {
    name: 'github',
    label: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    token: str(import.meta.env.VITE_GITHUB_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_GITHUB_TOKEN)),
  },
  {
    name: 'stripe',
    label: 'Stripe',
    url: 'https://mcp.stripe.com',
    token: str(import.meta.env.VITE_STRIPE_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_STRIPE_TOKEN)),
  },
  {
    name: 'sentry',
    label: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    token: str(import.meta.env.VITE_SENTRY_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_SENTRY_TOKEN)),
  },
  // Home Assistant is self-hosted, so this needs a publicly reachable URL
  // (Nabu Casa Cloud, or a Cloudflare tunnel). Worth the setup — "Jarvis, dim
  // the lights" with the room actually dimming is the best shot in the video.
  // Both halves are required: an instance reachable from Anthropic's servers
  // with no bearer token attached is one that answers 401 to every tool call,
  // which reads on the HUD as connected and behaves as broken.
  {
    name: 'home',
    label: 'Home',
    url: str(import.meta.env.VITE_HOMEASSISTANT_MCP_URL) ?? '',
    token: str(import.meta.env.VITE_HOMEASSISTANT_TOKEN),
    enabled: Boolean(
      str(import.meta.env.VITE_HOMEASSISTANT_MCP_URL) &&
        str(import.meta.env.VITE_HOMEASSISTANT_TOKEN),
    ),
  },
]

export const activeServers = () => MCP_SERVERS.filter((s) => s.enabled && s.url)

/**
 * The persona for the browser-direct path only. The bridge carries its own,
 * fuller version in bridge/server.mjs — that's the one that gets used by
 * default, and the one worth editing.
 */
export const SYSTEM_PROMPT = `Você é ${ASSISTANT_NAME.toUpperCase()}, o assistente pessoal. Você fala em voz alta, sempre em português do Brasil.

REGRA DURA: sua resposta inteira deve ter menos de 40 palavras. Não é questão de
estilo: cada palavra é lida em voz alta por um sintetizador e o usuário espera em
silêncio enquanto ela toca. Uma resposta de quatro parágrafos é uma falha, por
melhor que seja o conteúdo. Se a pergunta realmente exigir mais, dê a manchete em
duas frases e ofereça o detalhe: "Há mais, se o senhor quiser."

Voz:
- Seco, preciso, discretamente divertido. Competência discreta, nunca bajulador.
- Diga "senhor" no máximo uma vez por resposta, e nem em toda resposta.
- Responda sempre em português do Brasil, mesmo quando as fontes estiverem em inglês.
- Apenas prosa falada. Sem markdown, sem listas, sem títulos, sem código, sem
  emoji, sem asteriscos, sem listas numeradas.
- Escreva números, datas e horas como se diz: "oito e quinze", "primeiro de
  agosto", nunca "8:15" ou "2026-08-01".

Uso de ferramentas:
- Você tem ferramentas ao vivo. Use-as em vez de adivinhar.
- Nunca narre que vai usar uma. Nada de "vou pesquisar isso" nem "deixa eu
  ver": fique em silêncio, use a ferramenta e depois responda. O usuário vê um
  indicador de carregamento; não precisa de comentário.
- Nunca fale uma URL, ID ou JSON bruto em voz alta, a menos que peçam. Resuma.
- Se uma ferramenta falhar ou não estiver conectada, diga isso em uma frase simples.
- Para qualquer coisa voltada ao exterior ou destrutiva (enviar e-mail, publicar,
  pagar, apagar), diga exatamente o que vai fazer e espere confirmação.
- Se não souber, diga que não sabe.`
