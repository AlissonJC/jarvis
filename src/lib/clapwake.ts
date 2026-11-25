import { getMic } from './audio'
import { speechState } from './tts'
import {
  ALL_KINDS,
  MIN_GAP_MS,
  createPattern,
  isMuted,
  parseKinds,
  pickKind,
  type ClapKind,
} from './clapPattern'
import { CLAP_KINDS_RAW, CLAP_SENSITIVITY, CLAP_WAKE, CLAP_WINDOW_MS } from '../config'

/**
 * Wake him with a double clap or a double finger snap.
 *
 * Three parts, each doing the one thing it is good at:
 *
 *  - public/clap-worklet.js, on the audio thread, finds sharp short sounds and
 *    timestamps them to the sample. It costs a few multiplications per block,
 *    works in a background tab, and is the only thing running while the room is
 *    quiet. (YAMNet alone cannot do this: it scores a 0.975 s window, so two
 *    claps 300 ms apart are one window and one answer.)
 *  - YAMNet, through MediaPipe's audio classifier (served from our own origin,
 *    see scripts/start.mjs), looks at the second of audio around each of those
 *    sounds and says what it was. Door, cough, keyboard and speech are rejected
 *    here; only "Clapping" and "Finger snapping" go on. It runs a handful of
 *    times an hour, not continuously — the MediaPipe JavaScript API classifies
 *    clips, not a live stream, and a gated clip is the lower-duty way to use it.
 *  - clapPattern.ts decides: two sharp sounds between 150 ms and the window
 *    apart whose clip the classifier calls a clap or a snap, never while he
 *    speaks, then a cooldown. The verdict is read on the clip around the SECOND
 *    sound, which by then holds both: YAMNet recognises claps far better as
 *    clap-clap than as a lone sound in a quiet room.
 *
 * It listens on the microphone stream audio.ts already opened — one
 * getUserMedia for the whole page — in its own 16 kHz AudioContext, which is
 * the rate the classifier wants and spares a resampler.
 *
 * Optional, like gesture control: if the model or the WASM will not load it
 * says so once and the voice wake word carries on untouched.
 */

const MODEL_URL = '/models/yamnet.tflite'
const WASM_BASE = '/mediapipe'
const RATE = 16000
/**
 * A sound is reported ~100 ms after it began (the gate waits to see it die
 * away). A first sound can only be called a "single" once its window and this
 * delay have passed, or a second sound still on its way would find it already
 * given up on.
 */
const ONSET_DELAY_MS = 250

export const clapDiag = {
  /** off (configured off) | loading | listening | failed */
  state: 'off' as 'off' | 'loading' | 'listening' | 'failed',
  error: '',
  threshold: CLAP_SENSITIVITY,
  kinds: '' as string,
  /** Sharp sounds the audio-thread gate passed on. */
  onsets: 0,
  /** ...of which classified (the rest were while he spoke, or he was awake). */
  classified: 0,
  /** Top class of the last classified sound, whatever it was. */
  lastClass: '',
  lastScore: 0,
  lastAt: 0,
  /** Best clap/snap reading of it, and what the pattern did with it. */
  lastKind: '' as ClapKind | '',
  lastKindScore: 0,
  lastOutcome: '',
  /** Sounds that were neither clap nor snap. */
  notClap: 0,
  /** Single sounds whose partner never came. */
  singles: 0,
  /** Double patterns that woke him. */
  wakes: 0,
  muted: 0,
  belowThreshold: 0,
  /** Milliseconds the last classification took. */
  inferMs: 0,
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__clapwake = clapDiag
}

export type ClapWake = { stop: () => void }

export type ClapWakeHandlers = {
  /** Only while this is true do sounds count at all (he is dormant). */
  active: () => boolean
  /** A double clap or snap: wake him, exactly as his name would. */
  onWake: () => void
}

const NOOP: ClapWake = { stop: () => {} }

export async function startClapWake(h: ClapWakeHandlers): Promise<ClapWake> {
  const parsed = parseKinds(CLAP_KINDS_RAW)
  if (parsed.unknown.length) {
    console.warn(`[jarvis] VITE_CLAP_KINDS: unknown "${parsed.unknown.join(', ')}" — use clap and/or snap.`)
  }
  const kinds = new Set<ClapKind>(parsed.kinds)
  clapDiag.kinds = parsed.kinds.join(',')
  if (!CLAP_WAKE) {
    clapDiag.state = 'off'
    return NOOP
  }

  clapDiag.state = 'loading'
  let ctx: AudioContext | null = null
  let node: AudioWorkletNode | null = null
  let classifier: { classify: (a: Float32Array, rate?: number) => unknown; close?: () => void } | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  try {
    const stream = await getMic()
    const { AudioClassifier, FilesetResolver } = await import('@mediapipe/tasks-audio')
    const fileset = await FilesetResolver.forAudioTasks(WASM_BASE)
    classifier = await AudioClassifier.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL },
      // Every class, so the panel can show what a false alarm really was.
      maxResults: -1,
      scoreThreshold: 0,
    })

    ctx = new AudioContext({ sampleRate: RATE })
    await ctx.audioWorklet.addModule('/clap-worklet.js')
    const source = ctx.createMediaStreamSource(stream)
    node = new AudioWorkletNode(ctx, 'clap-gate', { numberOfInputs: 1, numberOfOutputs: 0 })
    source.connect(node)
    void ctx.resume()
  } catch (err) {
    clapDiag.state = 'failed'
    clapDiag.error = err instanceof Error ? err.message : String(err)
    console.warn(
      `[jarvis] clap wake unavailable (${clapDiag.error}) — the voice wake word is unaffected. ` +
        'Run `npm start` once so the sound model is downloaded (docs/PALMAS.md).',
    )
    try {
      void ctx?.close()
    } catch {
      /* nothing to close */
    }
    return NOOP
  }

  const pattern = createPattern({ kinds, threshold: CLAP_SENSITIVITY, windowMs: CLAP_WINDOW_MS })
  /** Onsets awaiting their audio: sample index -> onset time (audio clock) and
   *  whether it was the second of a pair, whose verdict decides. */
  const waiting = new Map<number, { t: number; pair: boolean }>()
  let lastAt = 0
  let lastArrival = Date.now()
  const audioNow = () => (lastAt / RATE) * 1000 + (Date.now() - lastArrival)
  const sync = () => {
    clapDiag.singles = pattern.stats.singles
    clapDiag.wakes = pattern.stats.wakes
    clapDiag.muted = pattern.stats.muted
    clapDiag.belowThreshold = pattern.stats.belowThreshold
  }

  node.port.onmessage = (e: MessageEvent) => {
    if (stopped) return
    const m = e.data as { type: string; sample: number; at?: number; clip?: Float32Array }
    if (m.type === 'onset') {
      lastAt = m.at ?? lastAt
      lastArrival = Date.now()
      clapDiag.onsets++
      if (!h.active()) return
      const t = (m.sample / RATE) * 1000
      // When the sound began on the wall clock: it was confirmed ~100 ms later.
      const wall = Date.now() - (((m.at ?? m.sample) - m.sample) / RATE) * 1000
      const outcome = pattern.onset(t, isMuted(speechState(), wall))
      sync()
      // His own speaker is not worth the CPU; everything else is classified,
      // so the panel shows what a false alarm really was.
      if (outcome !== 'muted') waiting.set(m.sample, { t, pair: outcome === 'pair' })
      return
    }
    if (m.type !== 'clip' || !m.clip) return
    const sound = waiting.get(m.sample)
    waiting.delete(m.sample)
    if (!sound || !h.active() || !classifier) return

    const t0 = performance.now()
    let cats: { categoryName: string; score: number }[] = []
    try {
      const out = classifier.classify(m.clip, RATE) as {
        classifications: { categories: { categoryName: string; score: number }[] }[]
      }[]
      cats = out[0]?.classifications[0]?.categories ?? []
    } catch (err) {
      clapDiag.error = err instanceof Error ? err.message : String(err)
      return
    }
    clapDiag.inferMs = Math.round(performance.now() - t0)
    clapDiag.classified++
    const top = cats.reduce((a, c) => (c.score > a.score ? c : a), { categoryName: '', score: 0 })
    clapDiag.lastClass = top.categoryName
    clapDiag.lastScore = top.score
    clapDiag.lastAt = Date.now()

    const pick = pickKind(cats, new Set(ALL_KINDS))
    clapDiag.lastKind = pick?.kind ?? ''
    clapDiag.lastKindScore = pick?.score ?? 0
    if (!sound.pair) {
      clapDiag.lastOutcome = pick ? 'first sound (waits for a second)' : 'first sound, not a clap or snap'
      return
    }
    if (!pick) {
      clapDiag.notClap++
      clapDiag.lastOutcome = 'pair, but not a clap or snap'
      return
    }
    // Muted was decided at the onset; look again now, in case he started a
    // sentence while the audio was being collected.
    const outcome = pattern.verdict(sound.t, {
      kind: pick.kind,
      score: pick.score,
      muted: isMuted(speechState(), Date.now()),
    })
    clapDiag.lastOutcome = `pair → ${outcome}`
    sync()
    if (outcome === 'wake' && h.active()) h.onWake()
  }

  // A first sound whose partner never came is a "single" once its window passes.
  timer = setInterval(() => {
    pattern.expire(audioNow() - ONSET_DELAY_MS)
    sync()
  }, 250)

  clapDiag.state = 'listening'
  console.info(
    `[jarvis] clap wake on: ${clapDiag.kinds}, score ≥ ${CLAP_SENSITIVITY}, ` +
      `${MIN_GAP_MS}-${CLAP_WINDOW_MS} ms apart.`,
  )

  return {
    stop: () => {
      stopped = true
      if (timer) clearInterval(timer)
      waiting.clear()
      try {
        node?.disconnect()
        // The shared microphone stream belongs to audio.ts and is not stopped.
        void ctx?.close()
        classifier?.close?.()
      } catch {
        /* already gone */
      }
      clapDiag.state = 'off'
    },
  }
}
