/**
 * Serves the BUILT face (`npm run build` -> dist/) on 127.0.0.1, and hands the
 * page this run's bridge token.
 *
 * Why this exists. Day to day the face should not be a Vite dev server: that
 * server carries a hot-reload socket and a CSP with 'unsafe-inline', and it
 * inlines the bridge token into a module that anything on the machine can fetch
 * (docs/REVISAO-SEGURANCA-2.md, N8 and L3). The built page needs none of that,
 * but it also cannot have the token baked in, because the token is new on every
 * start. So the token travels the way the page's own files do: `/jarvis-config.js`
 * answers with `window.__JARVIS__ = { token }` for this run, and the built
 * index.html loads it as a script of its own origin (the CSP's 'self').
 *
 *   JARVIS_BRIDGE_TOKEN   the same value the bridge was started with (required)
 *   PORT                  default 4173; the bridge must be told this origin:
 *                         JARVIS_FACE_ORIGIN=http://localhost:4173
 *   JARVIS_DIST           default ./dist
 *
 * What it does and does not promise. Bound to loopback; refuses any Host that is
 * not loopback (DNS rebinding); sends no CORS headers, so no other page can read
 * the token with fetch; gives the config file only to a request the browser marks
 * as a same-origin script load (`Sec-Fetch-Site: same-origin` and
 * `Sec-Fetch-Dest: script`), so a request with no Fetch Metadata at all is
 * refused (docs/SEGURANCA.md, S8). A program on this machine that sets those two
 * headers itself still gets the token: the token is not a secret from local
 * processes, only from web pages and from dev servers that were never given it.
 * Everything else is plain static files; nothing is written.
 */

import { createServer } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.tflite': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json; charset=utf-8',
}

const TOKEN_FORM = /^[A-Za-z0-9_-]{16,128}$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

const hostOk = (host) => {
  try {
    return LOCAL_HOSTS.has(new URL(`http://${host}`).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** @returns {import('node:http').Server} not yet listening */
export function createFaceServer({ root, token = '', port }) {
  const base = resolve(root)
  const bridgeToken = TOKEN_FORM.test(token) ? token : ''
  const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`])

  const common = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'content-security-policy': "frame-ancestors 'none'",
  }

  return createServer(async (req, res) => {
    const reply = (status, headers = {}, body = '') => {
      res.writeHead(status, { ...common, ...headers })
      res.end(body)
    }
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, { allow: 'GET, HEAD' })
      if (!hostOk(req.headers.host)) return reply(403, {}, 'forbidden')
      const url = new URL(req.url ?? '/', 'http://x')

      if (url.pathname === '/jarvis-config.js') {
        const site = req.headers['sec-fetch-site']
        const dest = req.headers['sec-fetch-dest']
        const origin = req.headers.origin
        // Only the page's own <script src>: a browser says so with Fetch Metadata. A
        // request that carries none (an old browser, another program of another user
        // of this machine) is refused too: absence is not permission (S8).
        if (site !== 'same-origin' || dest !== 'script' || (origin && !origins.has(origin))) {
          return reply(403, {}, 'forbidden')
        }
        // The token is URL-safe by construction (TOKEN_FORM), so it needs no escaping,
        // but it goes through JSON anyway: this is a script.
        const body = `window.__JARVIS__ = Object.freeze({ token: ${JSON.stringify(bridgeToken)} })\n`
        return reply(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }, req.method === 'HEAD' ? '' : body)
      }

      let rel
      try {
        rel = decodeURIComponent(url.pathname)
      } catch {
        return reply(400, {}, 'bad path')
      }
      if (rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return reply(403, {}, 'forbidden')
      if (rel.endsWith('/')) rel += 'index.html'
      const file = join(base, rel)
      let real
      try {
        real = await realpath(file)
        const top = await realpath(base)
        if (real !== top && !real.startsWith(top + sep)) return reply(403, {}, 'forbidden')
        if (!(await stat(real)).isFile()) throw new Error('not a file')
      } catch {
        return reply(404, {}, 'not found')
      }
      const type = TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream'
      const body = await readFile(real)
      return reply(
        200,
        {
          'content-type': type,
          'content-length': String(body.length),
          // The page and its config are per run; the hashed assets Vite writes can be kept.
          'cache-control': /\/assets\//.test(rel) ? 'public, max-age=3600' : 'no-store',
        },
        req.method === 'HEAD' ? '' : body,
      )
    } catch (err) {
      console.error('[serve] request failed:', err?.message ?? err)
      if (!res.headersSent) reply(500, {}, 'error')
      else res.end()
    }
  })
}

// Run directly: `node scripts/serve.mjs`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 4173
  const root = process.env.JARVIS_DIST?.trim() || 'dist'
  const token = process.env.JARVIS_BRIDGE_TOKEN?.trim() ?? ''
  if (!TOKEN_FORM.test(token)) {
    console.warn('[serve] JARVIS_BRIDGE_TOKEN is missing or malformed: the face will have no token (the bridge must not ask for one)')
  }
  const server = createFaceServer({ root, token, port })
  server.on('error', (err) => {
    console.error(`[serve] could not listen on 127.0.0.1:${port}: ${err.message}`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`[serve] the built face on http://localhost:${port}/ (from ${resolve(root)}); the bridge must accept the origin http://localhost:${port}`)
  })
}
