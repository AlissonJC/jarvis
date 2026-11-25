import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TransientGate, CLIP_SAMPLES, POST_SAMPLES } from '../public/clap-worklet.js'

const SR = 16000

/** Deterministic noise so a failure reproduces. */
function rng(seed = 1) {
  let x = seed
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 0x80000000 - 1
  }
}

/** Seconds of quiet room noise, optionally with events mixed in. */
function room(seconds, events = [], floor = 0.003) {
  const r = rng(7)
  const out = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < out.length; i++) out[i] = r() * floor
  for (const ev of events) {
    const at = Math.round(ev.at * SR)
    for (let i = 0; at + i < out.length && i < (ev.len ?? SR); i++) out[at + i] += ev.fn(i / SR, r)
  }
  return out
}

/** A clap: a burst of broadband noise that dies away in a few tens of ms. */
const clap = (amp = 0.5, tau = 0.012) => ({ fn: (t, r) => r() * amp * Math.exp(-t / tau), len: SR / 4 })
/** A snap: shorter and brighter. */
const snap = (amp = 0.3) => ({ fn: (t, r) => r() * amp * Math.exp(-t / 0.004), len: SR / 8 })
/** Speech-like: a voiced tone with a hard start, held for 0.5 s. */
const voice = (amp = 0.3) => ({
  fn: (t) => amp * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t) + 0.3 * Math.sin(2 * Math.PI * 560 * t)),
  len: SR / 2,
})

function run(signal, opts) {
  const gate = new TransientGate({ sampleRate: SR, ...opts })
  const found = []
  for (let i = 0; i + 128 <= signal.length; i += 128) found.push(...gate.process(signal.subarray(i, i + 128)))
  return { found, gate }
}

const secs = (ev) => ev.sample / SR

test('a clap in a quiet room is one onset, timed to where the sound began', () => {
  const { found } = run(room(2, [{ at: 1.0, ...clap() }]))
  assert.equal(found.length, 1)
  assert.ok(Math.abs(secs(found[0]) - 1.0) < 0.02, `onset at ${secs(found[0])}`)
})

test('a snap, which is quieter and shorter, also passes', () => {
  const { found } = run(room(2, [{ at: 0.8, ...snap(0.25) }]))
  assert.equal(found.length, 1)
})

test('two claps 300 ms apart are two onsets, with their timing intact', () => {
  const { found } = run(room(3, [{ at: 1.0, ...clap() }, { at: 1.3, ...clap(0.4) }]))
  assert.equal(found.length, 2)
  assert.ok(Math.abs((secs(found[1]) - secs(found[0])) * 1000 - 300) < 20)
})

test('two claps 160 ms apart (a fast double) are still told apart', () => {
  const { found } = run(room(3, [{ at: 1.0, ...clap() }, { at: 1.16, ...clap() }]))
  assert.equal(found.length, 2)
})

test('one clap with a ringing tail is one onset, not two', () => {
  const ring = { fn: (t, r) => r() * 0.5 * Math.exp(-t / 0.012) + 0.12 * Math.exp(-t / 0.03) * Math.sin(2 * Math.PI * 900 * t), len: SR / 4 }
  const { found } = run(room(2, [{ at: 1.0, ...ring }]))
  assert.equal(found.length, 1)
})

test('speech is not an onset: it rises sharply but does not die away', () => {
  const { found, gate } = run(room(2, [{ at: 0.5, ...voice() }]))
  assert.equal(found.length, 0)
  assert.ok(gate.stats.sustained >= 0)
})

test('steady noise, even loud, is not an onset', () => {
  const { found } = run(room(2, [], 0.2))
  assert.equal(found.length, 0)
})

test('a slow swell (music coming in) is not an onset', () => {
  const swell = { fn: (t, r) => r() * 0.4 * Math.min(1, t / 0.4), len: SR }
  const { found } = run(room(2, [{ at: 0.5, ...swell }]))
  assert.equal(found.length, 0)
})

test('a sound too quiet to matter is ignored however sharp it is', () => {
  const { found } = run(room(2, [{ at: 1.0, ...clap(0.03) }], 0.0005))
  assert.equal(found.length, 0)
})

test('clip geometry fits YAMNet and keeps the onset 0.6 s from the start', () => {
  assert.equal(CLIP_SAMPLES, 15600)
  assert.equal(POST_SAMPLES, 6000)
  assert.equal(CLIP_SAMPLES - POST_SAMPLES, 9600)
})
