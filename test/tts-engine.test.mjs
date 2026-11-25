// /health and /tts when no speech engine is configured, or the edge CLI is
// missing: the face must be told "no cloud voice" so it uses the browser's.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))

async function withBridge(env, fn) {
  // An empty home: no ~/.claude.json, so no ElevenLabs key can leak in.
  const home = mkdtempSync(join(tmpdir(), 'jarvis-home-'))
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, JARVIS_BRIDGE_PORT: '0', ELEVENLABS_API_KEY: '', HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no start: ${log}`)), 15_000)
      child.once('exit', (c) => reject(new Error(`bridge exited ${c}: ${log}`)))
      const poll = setInterval(() => {
        const m = /bridge listening on ws:\/\/\S+:(\d+)/.exec(log)
        if (m) {
          clearTimeout(t)
          clearInterval(poll)
          resolve(Number(m[1]))
        }
      }, 50)
    })
    return await fn(port, () => log)
  } finally {
    child.kill()
    rmSync(home, { recursive: true, force: true })
  }
}

test('no engine configured: no cloud voice', async () => {
  await withBridge({}, async (port) => {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    assert.deepEqual(h, { ok: true, tts: false, ttsEngine: null, stt: false, ttsTimeoutMs: 15000 })
    const r = await fetch(`http://127.0.0.1:${port}/tts`, { method: 'POST', body: '{"text":"oi"}' })
    assert.equal(r.status, 503)
  })
})

test('JARVIS_TTS_ENGINE=edge with a missing CLI degrades to the browser voice', async () => {
  await withBridge({ JARVIS_TTS_ENGINE: 'edge', JARVIS_EDGE_TTS_BIN: '/nonexistent/edge-tts' }, async (port, log) => {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    assert.equal(h.tts, false)
    assert.match(log(), /edge-tts command did not run/)
  })
})

test('an unknown JARVIS_TTS_ENGINE is ignored with a warning', async () => {
  await withBridge({ JARVIS_TTS_ENGINE: 'siri' }, async (port, log) => {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    assert.equal(h.tts, false)
    assert.match(log(), /not edge or elevenlabs/)
  })
})
