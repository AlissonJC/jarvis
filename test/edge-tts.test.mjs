// The /tts endpoint with JARVIS_TTS_ENGINE=edge, against the real bridge but a
// fake `edge-tts` command: no network, no Microsoft, no sound. What is under
// test is the bridge's own behaviour — cache, timeout, failure, /health.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'jarvis-edge-'))
const home = join(work, 'home') // empty: no ~/.claude.json, so no ElevenLabs key
mkdirSync(home)
const cache = join(work, 'cache')
const calls = join(work, 'calls.log')
const fake = join(work, 'edge-tts')

// Behaves like the CLI for what the bridge uses: --version, and
// --text=... --write-media=FILE. "FALHA" fails, "LENTO" hangs, "MUDO" writes
// a file too small to be audio.
writeFileSync(
  fake,
  `#!/bin/sh
[ "$1" = "--version" ] && exit 0
for a in "$@"; do
  case "$a" in
    --text=*) TEXT="\${a#--text=}" ;;
    --write-media=*) OUT="\${a#--write-media=}" ;;
  esac
done
echo "$TEXT" >> "${calls}"
case "$TEXT" in
  *FALHA*) echo "boom" >&2; exit 1 ;;
  *LENTO*) sleep 30; exit 0 ;;
  *MUDO*) printf 'x' > "$OUT"; exit 0 ;;
esac
head -c 3000 /dev/zero > "$OUT"
`,
)
chmodSync(fake, 0o755)

let bridge
let port
let log = ''

before(async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      JARVIS_BRIDGE_PORT: '0',
      JARVIS_TTS_ENGINE: 'edge',
      JARVIS_EDGE_TTS_BIN: fake,
      JARVIS_TTS_CACHE: cache,
      JARVIS_TTS_TIMEOUT_MS: '1500',
      ELEVENLABS_API_KEY: '',
      HOME: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bridge = child
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`bridge did not start: ${log}`)), 15_000)
    const poll = setInterval(() => {
      const m = /bridge listening on ws:\/\/\S+:(\d+)/.exec(log)
      if (m && /filler phrases ready/.test(log)) {
        port = Number(m[1])
        clearTimeout(t)
        clearInterval(poll)
        resolve()
      }
    }, 50)
    child.on('exit', (c) => reject(new Error(`bridge exited ${c}: ${log}`)))
  })
})

after(() => {
  bridge?.kill()
  rmSync(work, { recursive: true, force: true })
})

const post = (text) =>
  fetch(`http://127.0.0.1:${port}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
const callCount = () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0)

test('/health reports tts from the edge voice and leaves stt to the ElevenLabs key', async () => {
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
  assert.deepEqual(h, { ok: true, tts: true, ttsEngine: 'edge', stt: false, ttsTimeoutMs: 1500 })
})

test('the canned waiting phrases were pre-generated at start', () => {
  assert.match(log, /filler phrases ready: \d+ generated, \d+ cached, 0 failed/)
  const files = readdirSync(cache).filter((f) => f.endsWith('.mp3'))
  assert.ok(files.length >= 20, `only ${files.length} cached`)
})

test('/tts returns an MP3 body and caches it on disk', async () => {
  const before = callCount()
  const a = await post('Muito bem, senhor. Isto é um teste.')
  assert.equal(a.status, 200)
  assert.equal(a.headers.get('content-type'), 'audio/mpeg')
  assert.equal((await a.arrayBuffer()).byteLength, 3000)
  assert.equal(callCount(), before + 1)
  const b = await post('Muito bem, senhor. Isto é um teste.')
  assert.equal(b.status, 200)
  assert.equal((await b.arrayBuffer()).byteLength, 3000)
  assert.equal(callCount(), before + 1, 'second request must come from the cache')
})

test('a pre-generated filler is served without calling the CLI', async () => {
  const before = callCount()
  const res = await post('Pois não, senhor?')
  assert.equal(res.status, 200)
  await res.arrayBuffer()
  assert.equal(callCount(), before)
})

test('a line starting with a dash is text, not an option', async () => {
  const res = await post('--version é uma opção')
  assert.equal(res.status, 200)
  await res.arrayBuffer()
})

test('CLI failure answers fast with an error status', async () => {
  const t0 = Date.now()
  const res = await post('isto vai dar FALHA')
  assert.equal(res.status, 502)
  assert.ok(Date.now() - t0 < 3000)
})

test('a hung CLI is killed at the timeout and answers 504', async () => {
  const t0 = Date.now()
  const res = await post('isto é LENTO demais')
  const took = Date.now() - t0
  assert.equal(res.status, 504)
  assert.ok(took >= 1400 && took < 4000, `took ${took} ms`)
})

test('an empty file from the CLI is an error, not silence', async () => {
  assert.equal((await post('isto é MUDO')).status, 502)
})

test('nothing to say, no text, bad JSON and oversize text are refused', async () => {
  assert.equal((await post('...')).status, 422)
  assert.equal((await post('')).status, 400)
  assert.equal((await post('a'.repeat(1600))).status, 413)
  const bad = await fetch(`http://127.0.0.1:${port}/tts`, { method: 'POST', body: '{nope' })
  assert.equal(bad.status, 400)
})

test('the same sentence asked for twice at once is synthesised once', async () => {
  const before = callCount()
  const [a, b] = await Promise.all([post('Pedido duplicado ao mesmo tempo.'), post('Pedido duplicado ao mesmo tempo.')])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  await Promise.all([a.arrayBuffer(), b.arrayBuffer()])
  assert.equal(callCount(), before + 1)
})

test('a non-positive or non-numeric JARVIS_TTS_TIMEOUT_MS falls back to the default', async () => {
  const { execFileSync } = await import('node:child_process')
  const read = (env) =>
    Number(
      execFileSync(
        process.execPath,
        ['--input-type=module', '-e', `import { TIMEOUT_MS } from ${JSON.stringify(new URL('../bridge/edge-tts.mjs', import.meta.url).href)}; console.log(TIMEOUT_MS)`],
        { env: { PATH: process.env.PATH, ...env } },
      ),
    )
  assert.equal(read({}), 15000)
  assert.equal(read({ JARVIS_TTS_TIMEOUT_MS: '-5' }), 15000)
  assert.equal(read({ JARVIS_TTS_TIMEOUT_MS: '0' }), 15000)
  assert.equal(read({ JARVIS_TTS_TIMEOUT_MS: 'abc' }), 15000)
  assert.equal(read({ JARVIS_TTS_TIMEOUT_MS: 'Infinity' }), 15000)
  assert.equal(read({ JARVIS_TTS_TIMEOUT_MS: '2500' }), 2500)
  // The older name still counts, and a bad new one does not hide a good old one.
  assert.equal(read({ JARVIS_EDGE_TIMEOUT_MS: '4000' }), 4000)
  assert.equal(read({ JARVIS_TTS_TIMEOUT_MS: '-1', JARVIS_EDGE_TIMEOUT_MS: '4000' }), 4000)
})
