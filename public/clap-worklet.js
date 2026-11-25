/**
 * Audio-thread half of the clap / snap wake (see src/lib/clapwake.ts).
 *
 * Runs in an AudioWorklet, so it keeps working when the tab is in the
 * background (timers and animation frames do not). For every 128-sample block
 * it does a few multiplications and nothing else; only when a sharp, short
 * transient is found does it wake the main thread, with the ~1 s of audio around
 * the sound, which is what the YAMNet classifier looks at.
 *
 * The gate is a cheap pre-filter, not the decision. It exists so the classifier
 * (a few tens of ms of WASM per call) runs a handful of times an hour instead of
 * continuously, and so a quiet room costs next to nothing. YAMNet decides what
 * the sound was. The gate also supplies the timing: YAMNet scores a whole
 * 0.975 s window, far too coarse to tell that two claps came 300 ms apart.
 *
 * The gate is a plain class with no worklet globals so `node --test` can run it
 * (test/clap-gate.test.mjs); the processor at the bottom is only registered
 * when the file is loaded inside an AudioWorkletGlobalScope.
 */

/** YAMNet takes 15600 samples (0.975 s) at 16 kHz. */
export const CLIP_SAMPLES = 15600
/** Of which this many come after the onset: the rest is the lead-in. */
export const POST_SAMPLES = 6000 // 0.375 s at 16 kHz

export class TransientGate {
  /**
   * @param {object} [o]
   * @param {number} [o.sampleRate]
   * @param {number} [o.minPeak]   absolute floor, so a silent room cannot make a whisper a clap
   * @param {number} [o.riseRatio] peak must exceed the recent level by this factor
   * @param {number} [o.minCrest]  peak / rms of the block: an impulse is spiky, a voice is not
   * @param {number} [o.decayMs]   how long after the onset the sound must have died away
   * @param {number} [o.decayTo]   ...to below this fraction of the peak
   * @param {number} [o.refractoryMs] nothing new counts this soon after an onset (the
   *   decay window already keeps it quiet for decayMs; this only matters if it is longer)
   */
  constructor(o = {}) {
    this.sampleRate = o.sampleRate ?? 16000
    this.minPeak = o.minPeak ?? 0.06
    this.riseRatio = o.riseRatio ?? 6
    this.minCrest = o.minCrest ?? 2.2
    this.decayBlocks = Math.max(1, Math.round(((o.decayMs ?? 96) / 1000) * this.sampleRate / 128))
    this.decayTo = o.decayTo ?? 0.4
    this.refractoryBlocks = Math.max(1, Math.round(((o.refractoryMs ?? 60) / 1000) * this.sampleRate / 128))
    /** RMS of recent blocks, newest last. */
    this.history = []
    this.keep = 14
    this.blocks = 0
    this.sample = 0
    this.candidate = null
    this.quietUntil = 0
    /** Counters for the diagnostics panel. */
    this.stats = { candidates: 0, confirmed: 0, sustained: 0 }
  }

  /**
   * Feed one block. Returns the onsets confirmed by this block, each with the
   * absolute sample index where the sound started.
   * @param {Float32Array} block
   * @returns {{ sample: number, peak: number }[]}
   */
  process(block) {
    let peak = 0
    let sum = 0
    for (let i = 0; i < block.length; i++) {
      const a = Math.abs(block[i])
      if (a > peak) peak = a
      sum += block[i] * block[i]
    }
    const rms = Math.sqrt(sum / block.length)
    const out = []
    const index = this.blocks
    const start = this.sample

    if (this.candidate) {
      // Judging a transient: has it died away?
      if (index - this.candidate.block >= this.decayBlocks) {
        if (rms <= this.candidate.peak * this.decayTo) {
          this.stats.confirmed++
          out.push({ sample: this.candidate.sample, peak: this.candidate.peak })
        } else {
          this.stats.sustained++
        }
        this.quietUntil = this.candidate.block + this.refractoryBlocks
        this.candidate = null
      } else if (peak > this.candidate.peak) {
        this.candidate.peak = peak
      }
    } else if (index >= this.quietUntil && peak >= this.minPeak && rms > 0) {
      // Level just before, skipping the newest block (the attack may have begun
      // there). The median keeps one earlier click from raising the bar.
      const before = this.history.slice(0, -1).slice(-10).sort((a, b) => a - b)
      const base = before.length ? before[Math.floor(before.length / 2)] : 0
      if (peak >= Math.max(base, 0.004) * this.riseRatio && peak / rms >= this.minCrest) {
        this.stats.candidates++
        this.candidate = { block: index, sample: start, peak }
      }
    }

    this.history.push(rms)
    if (this.history.length > this.keep) this.history.shift()
    this.blocks++
    this.sample += block.length
    return out
  }
}

/* eslint-disable no-undef */
if (typeof registerProcessor === 'function') {
  class ClapProcessor extends AudioWorkletProcessor {
    constructor() {
      super()
      this.gate = new TransientGate({ sampleRate })
      this.ring = new Float32Array(32768)
      this.written = 0
      /** Onsets waiting for their post-roll to arrive. */
      this.pending = []
    }

    process(inputs) {
      const ch = inputs[0]?.[0]
      if (!ch) return true
      const n = ch.length
      for (let i = 0; i < n; i++) this.ring[(this.written + i) % this.ring.length] = ch[i]
      this.written += n

      for (const ev of this.gate.process(ch)) {
        this.pending.push({ ...ev, due: ev.sample + POST_SAMPLES })
        this.port.postMessage({ type: 'onset', sample: ev.sample, peak: ev.peak, at: this.written })
      }

      while (this.pending.length && this.written >= this.pending[0].due) {
        const ev = this.pending.shift()
        const clip = new Float32Array(CLIP_SAMPLES)
        const first = ev.due - CLIP_SAMPLES
        for (let i = 0; i < CLIP_SAMPLES; i++) {
          const abs = first + i
          clip[i] = abs >= 0 && abs >= this.written - this.ring.length ? this.ring[abs % this.ring.length] : 0
        }
        this.port.postMessage({ type: 'clip', sample: ev.sample, peak: ev.peak, clip }, [clip.buffer])
      }
      return true
    }
  }
  registerProcessor('clap-gate', ClapProcessor)
}
