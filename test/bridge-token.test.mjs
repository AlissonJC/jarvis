// L4: the bridge's per-start token, checked against the real bridge process.
//
// Nothing here talks to Claude: the agent executable is replaced by /bin/true,
// so a connection that is let in starts a session that ends at once.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
const TOKEN = 'k3y-0123456789abcdefABCDEF_-xyz'
const ORIGIN = 'http://localhost:5174'

function startBridge(env = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'jarvis-token-'))
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      JARVIS_BRIDGE_PORT: '0',
      JARVIS_FACE_ORIGIN: ORIGIN,
      JARVIS_DISABLE: 'browser,camera,interface,openjarvis',
      JARVIS_MCP_SERVERS: '',
      JARVIS_CLAUDE_EXECUTABLE: '/bin/true',
      JARVIS_WORKSPACE: join(scratch, 'ws'),
      JARVIS_TMP: join(scratch, 'tmp'),
      JARVIS_TTS_ENGINE: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  return new Promise((resolve, reject) => {
    const onData = (d) => {
      log += d
      const m = /bridge listening on ws:\/\/(\S+):(\d+)/.exec(log)
      if (m) resolve({ child, port: Number(m[2]), log: () => log })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (d) => (log += d))
    child.on('exit', (code) => reject(new Error(`bridge exited ${code}: ${log}`)))
    setTimeout(() => {
      child.kill()
      reject(new Error(`bridge did not start: ${log}`))
    }, 15_000).unref()
  })
}

const get = (port, path) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` }, timeout: 3000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })

/** Raw handshake; resolves the response head as text. */
const handshake = (port, protocols) =>
  new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port, timeout: 3000 })
    s.once('timeout', () => (s.destroy(), resolve('timeout')))
    s.once('error', () => resolve('error'))
    s.once('connect', () => {
      s.write(
        [
          'GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, `Origin: ${ORIGIN}`, 'Upgrade: websocket', 'Connection: Upgrade',
          'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          ...(protocols ? [`Sec-WebSocket-Protocol: ${protocols}`] : []),
        ].join('\r\n') + '\r\n\r\n',
      )
    })
    s.once('data', (d) => (s.destroy(), resolve(d.toString())))
  })

/** The startup banner is written line by line after the listening line; wait for one. */
async function logged(b, pattern) {
  for (let i = 0; i < 60 && !pattern.test(b.log()); i++) await new Promise((r) => setTimeout(r, 50))
  return b.log()
}

let bridge
let open
before(async () => {
  bridge = await startBridge({ JARVIS_BRIDGE_TOKEN: TOKEN })
  open = await startBridge({ JARVIS_BRIDGE_TOKEN: '' })
})
after(() => {
  bridge?.child.kill()
  open?.child.kill()
})

test('L4: /file, /img, /media and /page refuse a request with no token or the wrong one', async () => {
  for (const route of ['/file?path=/etc/hosts.png', '/img?url=https://example.com/a.png', '/media?url=https://example.com/a.mp4', '/page?url=https://example.com/']) {
    assert.deepEqual(await get(bridge.port, route), { status: 403, body: 'forbidden' }, route)
    assert.deepEqual(await get(bridge.port, `${route}&t=wrong-token-0123456789abcdef`), { status: 403, body: 'forbidden' }, `${route} (wrong token)`)
    assert.deepEqual(await get(bridge.port, `${route}&t=`), { status: 403, body: 'forbidden' }, `${route} (empty token)`)
  }
  assert.match(bridge.log(), /missing or wrong bridge token/)
})

test('L4: with the token the routes answer for themselves; /health needs none', async () => {
  assert.equal((await get(bridge.port, '/health')).status, 200)
  assert.deepEqual(await get(bridge.port, `/file?path=/etc/hosts&t=${TOKEN}`), { status: 400, body: 'images only' })
  // No session is open, so nothing may be fetched for a page: the egress rule, after the token.
  assert.deepEqual(await get(bridge.port, `/img?url=https://example.com/a.png&t=${TOKEN}`), { status: 403, body: 'not allowed' })
})

test('L4: with a session open, an address passes the egress rule and then meets the network rules', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, ['jarvis.v1', `jarvis.token.${TOKEN}`], { headers: { Origin: ORIGIN } })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  try {
    const r = await get(bridge.port, `/img?url=${encodeURIComponent('http://127.0.0.1:1/x.png')}&t=${TOKEN}`)
    assert.deepEqual(r, { status: 403, body: 'blocked host' }, 'past the token and the egress rule, stopped by the SSRF gate')
    const long = await get(bridge.port, `/img?url=${encodeURIComponent('https://example.com/' + 'a'.repeat(400))}&t=${TOKEN}`)
    assert.deepEqual(long, { status: 403, body: 'not allowed' }, 'a 400-character address never leaves')
  } finally {
    ws.close()
  }
})

test('L4: the WebSocket needs the token as a subprotocol, and the token is not echoed back', async () => {
  assert.match(await handshake(bridge.port, undefined), /^HTTP\/1\.1 403/)
  assert.match(await handshake(bridge.port, 'jarvis.v1'), /^HTTP\/1\.1 403/)
  assert.match(await handshake(bridge.port, 'jarvis.v1, jarvis.token.wrong-token-0123456789'), /^HTTP\/1\.1 403/)
  const ok = await handshake(bridge.port, `jarvis.v1, jarvis.token.${TOKEN}`)
  assert.match(ok, /^HTTP\/1\.1 101/)
  assert.match(ok, /Sec-WebSocket-Protocol: jarvis\.v1\r\n/i)
  assert.ok(!ok.includes(TOKEN), 'the token is not in the response')
})

test('L4: a malformed token in the environment is ignored with a warning, and the bridge says when it has none', async () => {
  const b = await startBridge({ JARVIS_BRIDGE_TOKEN: 'short' })
  try {
    assert.match(await logged(b, /JARVIS_BRIDGE_TOKEN is ignored/), /JARVIS_BRIDGE_TOKEN is ignored/)
    assert.match(await logged(b, /no JARVIS_BRIDGE_TOKEN/), /no JARVIS_BRIDGE_TOKEN/)
  } finally {
    b.child.kill()
  }
  assert.match(await logged(open, /no JARVIS_BRIDGE_TOKEN/), /no JARVIS_BRIDGE_TOKEN/)
  assert.match(await logged(bridge, /bridge token required/), /bridge token required/)
})

test('L4: without a token set the routes behave as before (the face started alone keeps working)', async () => {
  assert.equal((await get(open.port, '/file?path=/etc/hosts')).status, 400)
  assert.match(await handshake(open.port, undefined), /^HTTP\/1\.1 101/)
})
