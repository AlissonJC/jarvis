/**
 * Speech through Microsoft Edge's neural voices, by way of the `edge-tts` CLI.
 *
 * No key, no account: the CLI talks to the same service Edge's "Read aloud"
 * uses. The voice is en-US-BrianMultilingualNeural — a multilingual voice that
 * speaks whatever language the text is in, so Portuguese text comes out as
 * Portuguese. It slips into an American accent when the text is thick with
 * English names, which is what PHONETIC below is for: the same trick the
 * narration pipeline uses (a phonetic spelling only the voice ever sees).
 *
 * Every sentence is cached on disk under ~/.cache/jarvis/tts/, keyed by
 * sha256(voice + rate + pitch + the text the voice receives). Repeated lines,
 * and the canned waiting phrases pre-generated at start, play with no
 * synthesis wait at all.
 *
 * Failure is meant to be fast and loud: past TIMEOUT_MS, or on any error, the
 * promise rejects and /tts answers with an error status, so the face drops to
 * the browser voice for that sentence instead of hanging the queue.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDir } from './private-dir.mjs'

export const EDGE_VOICE = process.env.JARVIS_EDGE_VOICE?.trim() || 'en-US-BrianMultilingualNeural'
/** Narration settings that proved right for this voice: natural pace, a touch
 *  lower than its default pitch. */
const RATE = process.env.JARVIS_EDGE_RATE?.trim() || '+0%'
const PITCH = process.env.JARVIS_EDGE_PITCH?.trim() || '-4Hz'

export const CACHE_DIR = process.env.JARVIS_TTS_CACHE?.trim() || join(homedir(), '.cache', 'jarvis', 'tts')
const CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000

/** A spoken line is a sentence; this is far past one. */
export const MAX_TEXT = 1500
/**
 * Past this the request fails, and the face speaks with the browser voice.
 * JARVIS_TTS_TIMEOUT_MS sets it (JARVIS_EDGE_TIMEOUT_MS is the older name and
 * still works). 15 s because the Microsoft service is slow on some networks: at
 * 8 s, 6 of 8 uncached sentences timed out here, and one that succeeded took
 * 7.3 s. /health reports it as `ttsTimeoutMs`, and the face waits this long plus
 * a margin, so the server is always the one to give up first.
 */
/** The first positive, finite number among `values`, else `fallback`. A zero,
 *  a negative or text would otherwise become an instant (or absurd) timeout. */
export const positiveMs = (values, fallback) => {
  for (const v of values) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return fallback
}

export const TIMEOUT_MS = positiveMs(
  [process.env.JARVIS_TTS_TIMEOUT_MS, process.env.JARVIS_EDGE_TIMEOUT_MS],
  15000,
)
/** The face asks for the current sentence and primes the next one. */
const MAX_PARALLEL = 3

/**
 * Words that pull the multilingual voice into an English accent mid-sentence,
 * respelled the way a Brazilian says them. Matched as whole words.
 * Extend it when a word keeps sounding American.
 */
const PHONETIC = [
  // Measured with Whisper's language detector on a Google/YouTube sentence:
  // Portuguese probability 0.85 as written, 0.90 respelled.
  [/\bGoogle\b/g, 'Gúgol'],
  [/\bYouTube\b/gi, 'iutúbi'],
]

/** The text as the voice receives it. */
export function phonetic(text) {
  let out = text
  for (const [re, to] of PHONETIC) out = out.replace(re, to)
  return out
}

function binary() {
  const env = process.env.JARVIS_EDGE_TTS_BIN?.trim()
  if (env) return env
  const local = join(homedir(), '.local', 'bin', 'edge-tts')
  return existsSync(local) ? local : 'edge-tts'
}

/** Is the CLI there at all? Asked once at start so /health tells the truth. */
export function edgeAvailable() {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(binary(), ['--version'], { stdio: 'ignore' })
    } catch {
      return resolve(false)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(false)
    }, 5000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

export function cacheKey(spoken) {
  return createHash('sha256')
    .update([EDGE_VOICE, RATE, PITCH, spoken].join('\u0000'))
    .digest('hex')
}

const fileFor = (key) => join(CACHE_DIR, `${key}.mp3`)

let running = 0
const waiting = []
async function slot() {
  if (running < MAX_PARALLEL) {
    running++
    return
  }
  await new Promise((resolve) => waiting.push(resolve))
}
function release() {
  const next = waiting.shift()
  if (next) next()
  else running--
}

/** One CLI run -> an MP3 in `out`. Rejects on timeout, non-zero exit, or an
 *  implausibly small file (the CLI can exit 0 having received no audio). */
function run(spoken, out) {
  return new Promise((resolve, reject) => {
    const args = [
      `--voice=${EDGE_VOICE}`,
      `--rate=${RATE}`,
      `--pitch=${PITCH}`,
      // `--text=` rather than `-t`: a sentence starting with "-" must not be
      // parsed as an option. No shell is involved, so no quoting either.
      `--text=${spoken}`,
      `--write-media=${out}`,
      '--no-progress',
    ]
    const child = spawn(binary(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => {
      if (err.length < 2000) err += d
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(Object.assign(new Error(`edge-tts timed out after ${TIMEOUT_MS} ms`), { status: 504 }))
    }, TIMEOUT_MS)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(Object.assign(new Error(`edge-tts could not start: ${e.message}`), { status: 503 }))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve()
      reject(Object.assign(new Error(`edge-tts exited ${code}: ${err.trim().slice(-300)}`), { status: 502 }))
    })
  })
}

/** Sentences already being generated, so the same line asked for twice (a
 *  filler racing its own pre-generation) costs one synthesis. */
const inflight = new Map()

/**
 * MP3 bytes for `text`. From the cache when it is there, otherwise synthesised
 * and cached. `fromCache` on the result says which, for the timing logs.
 */
export async function synthesize(text) {
  const clean = String(text ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .trim()
  if (!/[\p{L}\p{N}]/u.test(clean)) {
    throw Object.assign(new Error('nothing to say'), { status: 422 })
  }
  if (clean.length > MAX_TEXT) {
    throw Object.assign(new Error('text too long'), { status: 413 })
  }
  const spoken = phonetic(clean)
  const key = cacheKey(spoken)
  const file = fileFor(key)

  try {
    return { mp3: await readFile(file), fromCache: true }
  } catch {
    /* not cached */
  }

  let pending = inflight.get(key)
  if (!pending) {
    pending = (async () => {
      await slot()
      const tmp = join(CACHE_DIR, `.${key}.${randomBytes(4).toString('hex')}.tmp.mp3`)
      try {
        ensurePrivateDir(CACHE_DIR)
        await run(spoken, tmp)
        const mp3 = await readFile(tmp)
        if (mp3.length < 400) {
          throw Object.assign(new Error('edge-tts returned no audio'), { status: 502 })
        }
        // Atomic, so a crash or a concurrent reader never sees half a file.
        await rename(tmp, file)
        return mp3
      } finally {
        await unlink(tmp).catch(() => {})
        release()
        inflight.delete(key)
      }
    })()
    inflight.set(key, pending)
  }
  return { mp3: await pending, fromCache: false }
}

/**
 * Fill the cache with a list of lines, two at a time so a live request always
 * finds a free slot. Never throws: this is an optimisation, and a line that
 * fails is simply synthesised when it is first needed. Resolves to counts.
 */
export async function pregenerate(lines) {
  const todo = [...lines]
  let made = 0
  let had = 0
  let failed = 0
  const worker = async () => {
    for (let line = todo.shift(); line !== undefined; line = todo.shift()) {
      try {
        const { fromCache } = await synthesize(line)
        if (fromCache) had++
        else made++
      } catch {
        failed++
      }
    }
  }
  await Promise.all([worker(), worker()])
  return { made, had, failed }
}

/** Drop cached lines nobody has needed for a month. Best effort, at start. */
export async function pruneCache() {
  try {
    const now = Date.now()
    for (const name of await readdir(CACHE_DIR)) {
      const file = join(CACHE_DIR, name)
      const { mtimeMs } = await stat(file)
      if (now - mtimeMs > CACHE_MAX_AGE_MS) await unlink(file)
    }
  } catch {
    /* no cache yet, or a file vanished */
  }
}
