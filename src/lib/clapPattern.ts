/**
 * The decision half of the clap / snap wake, as pure functions.
 *
 * What counts as a wake, in one place: two sharp sounds between MIN_GAP_MS and
 * the window apart, whose audio the classifier then calls a clap or a snap
 * (an accepted kind) with a score above the sensitivity threshold; never while
 * he is speaking; never twice within the cooldown. No browser imports, so
 * `node --test` drives it with synthetic event sequences
 * (test/clap-pattern.test.mjs). The sound detection itself is in
 * public/clap-worklet.js (timing) and clapwake.ts (the YAMNet classifier).
 *
 * Two steps, because they arrive at different times. `onset` is called the
 * moment a sharp sound is heard and says whether it is a first sound or the
 * second of a pair; the classifier needs another ~0.4 s of audio, and its
 * verdict on the clip around the second sound (which, by then, holds both) is
 * delivered with `verdict`. Judging the pair on one clip, rather than each
 * sound alone, is deliberate: YAMNet reads a clap far better as part of a
 * clap-clap than as one sound in a quiet room.
 *
 * All times are milliseconds on one monotonic clock (the audio clock), except
 * where a function says otherwise.
 */

export type ClapKind = 'clap' | 'snap'
export const ALL_KINDS: readonly ClapKind[] = ['clap', 'snap']

/**
 * YAMNet labels that count as each kind (exact strings from the model's label
 * map) and how much each is trusted. "Hands" is the parent of both "Clapping"
 * and "Finger snapping" in the AudioSet ontology and scores high for every real
 * clap and snap, including the dry single claps that "Clapping" alone rates low
 * (measured: a dry clap scored Clapping 0.20 but Hands 0.59). It is the weaker
 * evidence, so it counts at 70% and only towards "clap".
 */
export const KIND_LABELS: Record<ClapKind, readonly (readonly [string, number])[]> = {
  clap: [['Clapping', 1], ['Hands', 0.7]],
  snap: [['Finger snapping', 1]],
}

/** Two sounds closer than this are one sound heard twice (an echo, a ringing tail). */
export const MIN_GAP_MS = 150
/** After a wake, nothing counts for this long. */
export const COOLDOWN_MS = 2000
/** He is "speaking" for this long after the last sound leaves the speakers. */
export const MUTE_AFTER_MS = 300

/** `clap,snap` -> kinds. Unknown words are reported back, empty/blank means both. */
export function parseKinds(raw: unknown): { kinds: ClapKind[]; unknown: string[] } {
  const words = (typeof raw === 'string' ? raw : '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
  if (!words.length) return { kinds: [...ALL_KINDS], unknown: [] }
  const kinds = ALL_KINDS.filter((k) => words.includes(k))
  const unknown = words.filter((w) => !(ALL_KINDS as readonly string[]).includes(w))
  return { kinds: kinds.length ? kinds : [...ALL_KINDS], unknown }
}

/** Best kind among the classifier's categories, or null when none is present. */
export function pickKind(
  scores: ReadonlyMap<string, number> | Iterable<{ categoryName: string; score: number }>,
  allowed: ReadonlySet<ClapKind>,
): { kind: ClapKind; score: number } | null {
  const get = (name: string) =>
    scores instanceof Map
      ? (scores.get(name) ?? 0)
      : [...(scores as Iterable<{ categoryName: string; score: number }>)].find((c) => c.categoryName === name)?.score ?? 0
  let best: { kind: ClapKind; score: number } | null = null
  for (const kind of allowed) {
    const score = Math.max(0, ...KIND_LABELS[kind].map(([name, weight]) => get(name) * weight))
    if (score > 0 && (!best || score > best.score)) best = { kind, score }
  }
  return best
}

/**
 * Was the speaker playing his voice when a sound began (or just before)?
 * `endedAt` is when he last stopped (0 if never). A sound is muted if he is
 * speaking now — the conservative choice for one that began a moment ago — or
 * stopped less than `graceMs` before it. Wall-clock times, not audio-clock.
 */
export function isMuted(
  speech: { speaking: boolean; endedAt: number },
  soundAt: number,
  graceMs = MUTE_AFTER_MS,
): boolean {
  if (speech.speaking) return true
  return soundAt - speech.endedAt < graceMs
}

export type PatternConfig = {
  kinds: ReadonlySet<ClapKind>
  /** Minimum classifier score for the pair to count. */
  threshold: number
  /** Longest gap between the two sounds. */
  windowMs: number
  cooldownMs?: number
  minGapMs?: number
}

export type OnsetOutcome = 'first' | 'pair' | 'too-soon' | 'cooldown' | 'muted'
export type VerdictOutcome = 'wake' | 'below-threshold' | 'kind-off' | 'cooldown' | 'muted'

export type Pattern = {
  /** A sharp sound began at `t`. `muted`: he was speaking (see isMuted). */
  onset: (t: number, muted: boolean) => OnsetOutcome
  /** The classifier's reading of the clip around the sound that began at `t`.
   *  Only meaningful for an onset that returned 'pair'. */
  verdict: (t: number, v: { kind: ClapKind; score: number; muted: boolean }) => VerdictOutcome
  /** Call with the current time now and then: a first sound whose window has
   *  passed without a partner becomes a counted "single". */
  expire: (now: number) => void
  stats: { wakes: number; singles: number; muted: number; belowThreshold: number }
}

export function createPattern(cfg: PatternConfig): Pattern {
  const cooldown = cfg.cooldownMs ?? COOLDOWN_MS
  const minGap = cfg.minGapMs ?? MIN_GAP_MS
  const stats = { wakes: 0, singles: 0, muted: 0, belowThreshold: 0 }
  /** The latest sound; `paired` once a second one has joined it. */
  let pending: { t: number; paired: boolean } | null = null
  let lastWake = -Infinity

  const dropPending = () => {
    if (pending && !pending.paired) stats.singles++
    pending = null
  }

  return {
    stats,
    expire(now) {
      if (pending && now - pending.t > cfg.windowMs) dropPending()
    },
    onset(t, muted) {
      // His own voice never counts, and does not disturb a sound already waiting.
      if (muted) {
        stats.muted++
        return 'muted'
      }
      if (t - lastWake < cooldown) {
        pending = null
        return 'cooldown'
      }
      if (pending) {
        const gap = t - pending.t
        if (gap < minGap) return 'too-soon'
        if (gap <= cfg.windowMs) {
          // The newest sound stays the reference, so a run of three can still
          // pair the second with the third if the first pair is not accepted.
          pending = { t, paired: true }
          return 'pair'
        }
        dropPending()
      }
      pending = { t, paired: false }
      return 'first'
    },
    verdict(t, v) {
      if (v.muted) {
        stats.muted++
        return 'muted'
      }
      if (t - lastWake < cooldown) return 'cooldown'
      if (!cfg.kinds.has(v.kind)) return 'kind-off'
      if (v.score < cfg.threshold) {
        stats.belowThreshold++
        return 'below-threshold'
      }
      lastWake = t
      stats.wakes++
      pending = null
      return 'wake'
    },
  }
}
