import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bridgeOrigins, extraConnectSources, scriptSources } from '../vite.csp.ts'

test('the default bridge address gives the old origins, http and ws', () => {
  for (const raw of [undefined, '', '  ', 'ws://localhost:8787']) {
    const o = bridgeOrigins(raw)
    assert.deepEqual(o.http, ['http://localhost:8787', 'http://127.0.0.1:8787'])
    assert.deepEqual(o.ws, ['ws://localhost:8787', 'ws://127.0.0.1:8787'])
    assert.equal(o.warning, undefined)
  }
})

test('another port, a named host and wss are followed', () => {
  assert.deepEqual(bridgeOrigins('ws://localhost:8788/').http, ['http://localhost:8788', 'http://127.0.0.1:8788'])
  assert.deepEqual(bridgeOrigins('wss://jarvis.example.com').http, [
    'https://localhost',
    'https://127.0.0.1',
    'https://jarvis.example.com',
  ])
  assert.deepEqual(bridgeOrigins('ws://my-box.lan:9000').ws.at(-1), 'ws://my-box.lan:9000')
})

test('anything that could add a directive or a source is refused', () => {
  const bad = [
    'wss://host;script-src',
    'ws://a;b.com',
    'http://x y',
    'ws://localhost:8787 https://evil.com',
    'ws://user:pw@evil.com:1',
    "ws://localhost:8787'",
    'ws://localhost:8787"',
    'ws://evil.com/path',
    'ws://evil.com:99999',
    'ws://evil.com:0',
    'ws://-bad.com',
    'ws://*.evil.com',
    'ftp://localhost',
    'garbage',
    'ws://localhost:8787\nscript-src *',
  ]
  for (const raw of bad) {
    const o = bridgeOrigins(raw)
    assert.ok(o.warning, `${JSON.stringify(raw)} should warn`)
    assert.deepEqual(o.http, ['http://localhost:8787', 'http://127.0.0.1:8787'], raw)
    for (const s of [...o.http, ...o.ws]) assert.match(s, /^(https?|wss?):\/\/[A-Za-z0-9.:[\]-]+$/)
  }
})

test('connect sources: nothing remote by default (L3: no storage.googleapis.com); optional modes add theirs', () => {
  assert.deepEqual(extraConnectSources({}), [])
  assert.ok(!extraConnectSources({ backend: 'direct', ttsEngine: 'kokoro', elevenKey: 'k' }).some((h) => /googleapis/.test(h)))
  assert.ok(extraConnectSources({ backend: 'direct' }).includes('https://api.anthropic.com'))
  assert.ok(extraConnectSources({ elevenKey: 'k' }).includes('https://api.elevenlabs.io'))
  assert.ok(extraConnectSources({ ttsEngine: 'kokoro' }).includes('https://huggingface.co'))
  assert.ok(!extraConnectSources({ backend: 'bridge' }).some((h) => /anthropic|elevenlabs/.test(h)))
})

test('L3: the hand model is vendored and pinned, not fetched from a bucket', () => {
  const hands = readFileSync(new URL('../src/lib/hands.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(hands, /storage\.googleapis\.com/)
  assert.match(hands, /MODEL_URL = '\/models\/hand_landmarker\.task'/)
  const start = readFileSync(new URL('../scripts/start.mjs', import.meta.url), 'utf8')
  assert.match(start, /HAND_SHA256 = '[0-9a-f]{64}'/)
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  assert.doesNotMatch(html, /storage\.googleapis\.com/)
})

test('L3: script-src gets \'unsafe-inline\' only in dev and \'unsafe-eval\' only for the Kokoro voice', () => {
  assert.deepEqual(scriptSources({ dev: true }), ["'unsafe-inline'"])
  assert.deepEqual(scriptSources({ dev: false }), [])
  assert.deepEqual(scriptSources({ dev: false, ttsEngine: 'system' }), [])
  assert.deepEqual(scriptSources({ dev: false, ttsEngine: 'kokoro' }), ["'unsafe-eval'"])
  assert.deepEqual(scriptSources({ dev: true, ttsEngine: 'kokoro' }), ["'unsafe-inline'", "'unsafe-eval'"])
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /script-src 'self' __SCRIPT_EXTRA__ 'wasm-unsafe-eval' blob:;/)
})
