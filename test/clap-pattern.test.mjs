import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPattern,
  isMuted,
  parseKinds,
  pickKind,
  MIN_GAP_MS,
  COOLDOWN_MS,
  MUTE_AFTER_MS,
} from '../src/lib/clapPattern.ts'

const cfg = (over = {}) => ({ kinds: new Set(['clap', 'snap']), threshold: 0.35, windowMs: 600, ...over })
const good = { kind: 'clap', score: 0.8, muted: false }

/** Two sounds `gap` ms apart, then the verdict on the second. Returns [onset outcomes, verdict]. */
function pair(p, t1, gap, v = good) {
  const first = p.onset(t1, false)
  const second = p.onset(t1 + gap, false)
  return { first, second, verdict: second === 'pair' ? p.verdict(t1 + gap, v) : null }
}

test('two sounds 300 ms apart are a pair, and an accepted verdict wakes; the first alone does not', () => {
  const p = createPattern(cfg())
  assert.equal(p.onset(1000, false), 'first')
  assert.equal(p.stats.wakes, 0)
  assert.equal(p.onset(1300, false), 'pair')
  assert.equal(p.stats.wakes, 0) // not yet: the classifier has not spoken
  assert.equal(p.verdict(1300, good), 'wake')
  assert.equal(p.stats.wakes, 1)
})

test('any mix of clap and snap counts: the kind comes from the verdict', () => {
  for (const kind of ['clap', 'snap']) {
    const p = createPattern(cfg())
    assert.equal(pair(p, 0, 350, { kind, score: 0.6, muted: false }).verdict, 'wake', kind)
  }
})

test('the window is 150 ms to windowMs, inclusive of the edges', () => {
  const at = (gap, windowMs = 600) => pair(createPattern(cfg({ windowMs })), 0, gap).second
  assert.equal(at(MIN_GAP_MS - 1), 'too-soon')
  assert.equal(at(MIN_GAP_MS), 'pair')
  assert.equal(at(600), 'pair')
  assert.equal(at(601), 'first') // too late: it is a new first sound
  assert.equal(at(700, 800), 'pair') // wider window from config
})

test('a sound heard twice (too soon) is ignored and does not reset the first', () => {
  const p = createPattern(cfg())
  p.onset(0, false)
  assert.equal(p.onset(80, false), 'too-soon')
  assert.equal(p.onset(400, false), 'pair') // still measured from the first one
})

test('single sounds never wake, however many, if they are spaced beyond the window', () => {
  const p = createPattern(cfg())
  for (let i = 0; i < 10; i++) assert.equal(p.onset(i * 2000, false), 'first')
  p.expire(30_000)
  assert.equal(p.stats.wakes, 0)
  assert.equal(p.stats.singles, 10)
})

test('a first sound is counted as a single once its window has passed (expire)', () => {
  const p = createPattern(cfg())
  p.onset(0, false)
  p.expire(500)
  assert.equal(p.stats.singles, 0)
  p.expire(601)
  assert.equal(p.stats.singles, 1)
  p.expire(5000)
  assert.equal(p.stats.singles, 1)
})

test('a sound that was part of a pair is not counted as a single', () => {
  const p = createPattern(cfg())
  pair(p, 0, 300)
  p.expire(10_000)
  assert.equal(p.stats.singles, 0)
})

test('three sounds in a row wake once, then the cooldown holds', () => {
  const p = createPattern(cfg())
  p.onset(0, false)
  assert.equal(p.onset(300, false), 'pair')
  assert.equal(p.onset(600, false), 'pair') // the third pairs with the second; its verdict arrives later
  assert.equal(p.verdict(300, good), 'wake')
  assert.equal(p.verdict(600, good), 'cooldown')
  assert.equal(p.onset(900, false), 'cooldown')
  assert.equal(p.stats.wakes, 1)
})

test('after the cooldown a new pair wakes again', () => {
  const p = createPattern(cfg())
  pair(p, 0, 300) // pair is judged at t=300
  p.verdict(300, good)
  assert.equal(p.onset(300 + COOLDOWN_MS - 1, false), 'cooldown')
  assert.equal(p.onset(300 + COOLDOWN_MS + 100, false), 'first')
  assert.equal(p.onset(300 + COOLDOWN_MS + 400, false), 'pair')
  assert.equal(p.verdict(300 + COOLDOWN_MS + 400, good), 'wake')
  assert.equal(p.stats.wakes, 2)
})

test('a verdict under the threshold does not wake; exactly at it does', () => {
  const p = createPattern(cfg({ threshold: 0.5 }))
  assert.equal(pair(p, 0, 300, { kind: 'clap', score: 0.49, muted: false }).verdict, 'below-threshold')
  assert.equal(p.stats.wakes, 0)
  assert.equal(p.stats.belowThreshold, 1)
  assert.equal(pair(p, 5000, 300, { kind: 'clap', score: 0.5, muted: false }).verdict, 'wake')
})

test('the kinds filter: a kind switched off does not count', () => {
  const p = createPattern(cfg({ kinds: new Set(['clap']) }))
  assert.equal(pair(p, 0, 300, { kind: 'snap', score: 0.9, muted: false }).verdict, 'kind-off')
  assert.equal(p.stats.wakes, 0)
  assert.equal(pair(p, 5000, 300).verdict, 'wake')
})

test('sounds while he speaks never count, and do not disturb a pair already started', () => {
  const p = createPattern(cfg())
  assert.equal(p.onset(0, true), 'muted')
  assert.equal(p.onset(300, true), 'muted')
  assert.equal(p.stats.wakes, 0)
  assert.equal(p.stats.muted, 2)
  p.onset(5000, false)
  assert.equal(p.onset(5200, true), 'muted')
  assert.equal(p.onset(5400, false), 'pair')
  assert.equal(p.verdict(5400, good), 'wake')
})

test('he starts speaking between the second sound and its verdict: muted, no wake', () => {
  const p = createPattern(cfg())
  p.onset(0, false)
  assert.equal(p.onset(300, false), 'pair')
  assert.equal(p.verdict(300, { ...good, muted: true }), 'muted')
  assert.equal(p.stats.wakes, 0)
})

test('an unaccepted pair leaves the second sound free to pair with a third', () => {
  const p = createPattern(cfg())
  p.onset(0, false)
  p.onset(300, false)
  assert.equal(p.verdict(300, { kind: 'clap', score: 0.1, muted: false }), 'below-threshold')
  assert.equal(p.onset(600, false), 'pair')
  assert.equal(p.verdict(600, good), 'wake')
})

test('isMuted: while speaking, for 300 ms after, never before he has spoken', () => {
  assert.equal(MUTE_AFTER_MS, 300)
  assert.equal(isMuted({ speaking: true, endedAt: 0 }, 10_000), true)
  assert.equal(isMuted({ speaking: false, endedAt: 10_000 }, 10_200), true)
  assert.equal(isMuted({ speaking: false, endedAt: 10_000 }, 10_299), true)
  assert.equal(isMuted({ speaking: false, endedAt: 10_000 }, 10_300), false)
  assert.equal(isMuted({ speaking: false, endedAt: 10_000 }, 20_000), false)
  assert.equal(isMuted({ speaking: false, endedAt: 0 }, 1_764_000_000_000), false) // never spoke
  // A sound that began just before he stopped was heard while he spoke.
  assert.equal(isMuted({ speaking: false, endedAt: 10_000 }, 9_900), true)
})

test('parseKinds: default both, subset, case and spaces, unknown words reported', () => {
  assert.deepEqual(parseKinds(undefined).kinds, ['clap', 'snap'])
  assert.deepEqual(parseKinds('').kinds, ['clap', 'snap'])
  assert.deepEqual(parseKinds('clap').kinds, ['clap'])
  assert.deepEqual(parseKinds(' Snap , CLAP ').kinds, ['clap', 'snap'])
  const bad = parseKinds('clap,whistle')
  assert.deepEqual(bad.kinds, ['clap'])
  assert.deepEqual(bad.unknown, ['whistle'])
  assert.deepEqual(parseKinds('whistle').kinds, ['clap', 'snap'])
})

test('pickKind: reads the YAMNet labels, only among allowed kinds, highest wins', () => {
  const cats = [
    { categoryName: 'Door', score: 0.9 },
    { categoryName: 'Clapping', score: 0.41 },
    { categoryName: 'Finger snapping', score: 0.66 },
  ]
  assert.deepEqual(pickKind(cats, new Set(['clap', 'snap'])), { kind: 'snap', score: 0.66 })
  assert.deepEqual(pickKind(cats, new Set(['clap'])), { kind: 'clap', score: 0.41 })
  assert.equal(pickKind([{ categoryName: 'Door', score: 0.9 }], new Set(['clap', 'snap'])), null)
  assert.equal(pickKind(new Map([['Clapping', 0.5]]), new Set(['clap']))?.score, 0.5)
})

test('pickKind: "Hands" counts towards clap at 70%, never towards snap', () => {
  // A dry clap as YAMNet rated it in testing: Clapping low, Hands moderate.
  const dry = [
    { categoryName: 'Clapping', score: 0.2 },
    { categoryName: 'Hands', score: 0.59 },
  ]
  const p = pickKind(dry, new Set(['clap', 'snap']))
  assert.equal(p.kind, 'clap')
  assert.ok(Math.abs(p.score - 0.413) < 1e-9)
  assert.equal(pickKind(dry, new Set(['snap'])), null)
  // Clapping wins when it is the stronger reading.
  assert.equal(pickKind([{ categoryName: 'Clapping', score: 0.8 }, { categoryName: 'Hands', score: 0.9 }], new Set(['clap'])).score, 0.8)
})
