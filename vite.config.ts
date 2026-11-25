import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { bridgeOrigins as bridgeOriginsFor, extraConnectSources, scriptSources } from './vite.csp.ts'

/**
 * The page's Content-Security-Policy names the bridge by origin (index.html),
 * and it used to hard-code port 8787, so a bridge on any other port was blocked
 * by the browser with nothing in the interface to say why. This fills the
 * placeholder from VITE_BRIDGE_URL (the same variable the app itself reads), so
 * the policy follows the configured port in dev and in the build. With the
 * variable unset it is exactly the old policy. An address that is not a plain
 * ws://host:port is refused (see vite.csp.ts), because it lands in a header.
 */
function devPort(server: ViteDevServer): number {
  const addr = server.httpServer?.address()
  return typeof addr === 'object' && addr ? addr.port : server.config.server.port
}

function bridgeOrigins(mode: string): Plugin {
  return {
    name: 'jarvis-bridge-csp',
    transformIndexHtml(html, ctx) {
      const env = loadEnv(mode, process.cwd(), 'VITE_')
      const origins = bridgeOriginsFor(env.VITE_BRIDGE_URL)
      if (origins.warning) console.warn(`[jarvis] ${origins.warning}`)
      const connect = [
        ...origins.ws,
        ...extraConnectSources({
          backend: env.VITE_BACKEND?.trim(),
          ttsEngine: env.VITE_TTS_ENGINE?.trim(),
          elevenKey: env.VITE_ELEVENLABS_API_KEY?.trim(),
        }),
        // Vite's own hot-reload socket: this dev server's port, dev only.
        ...(ctx.server
          ? [`ws://localhost:${devPort(ctx.server)}`, `ws://127.0.0.1:${devPort(ctx.server)}`]
          : []),
      ]
      const page = html
        .replaceAll('__BRIDGE_ORIGINS__', origins.http.join(' '))
        .replaceAll('__CONNECT_EXTRA__', connect.join(' '))
        .replaceAll('__SCRIPT_EXTRA__', scriptSources({ dev: Boolean(ctx.server), ttsEngine: env.VITE_TTS_ENGINE?.trim() }).join(' '))
      // The built page gets its per-start bridge token from the static server that
      // serves it (scripts/serve.mjs answers this path), as a file of the page's own
      // origin, so 'self' covers it and the CSP needs no 'unsafe-inline'. The dev
      // server inlines VITE_BRIDGE_TOKEN instead and has no such route.
      return ctx.server ? page : page.replace('</head>', '    <script src="/jarvis-config.js"></script>\n  </head>')
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), bridgeOrigins(mode)],
  server: {
    // Honour PORT so a second instance can run alongside the first. The launcher
    // (scripts/start.mjs) picks the port and tells the bridge that exact origin;
    // strictPort makes Vite fail rather than move to another one, which the bridge
    // would then refuse.
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    // Vite's default answers any page on any localhost port with CORS headers, so
    // another local dev server's page could read this one's modules, and the bridge
    // token is inlined into one of them (docs/REVISAO-SEGURANCA-2.md, N8). The face
    // is same-origin with itself and needs none.
    cors: false,
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
}))
