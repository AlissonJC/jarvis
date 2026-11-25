import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSpeechActivity } from '../src/lib/speechActivity.ts'
import { isMuted } from '../src/lib/clapPattern.ts'

const make = () => {
  let t = 1_000
  const a = createSpeechActivity(() => t)
  return { a, at: (ms) => (t = ms) }
}

test('never spoken: not speaking, endedAt 0', () => {
  const { a } = make()
  assert.deepEqual(a.state(), { speaking: false, endedAt: 0 })
})

test('stays speaking across the gap between two queued sentences', () => {
  const { a, at } = make()
  a.owe() // sentence 1 queued
  a.owe() // sentence 2 queued behind it
  a.setText('um')
  assert.equal(a.state().speaking, true)
  // Sentence 1 finishes: its text clears first, then it is released.
  at(2_000)
  a.setText('')
  assert.equal(a.state().speaking, true, 'one more is still owed')
  a.settle()
  assert.equal(a.state().speaking, true)
  assert.equal(a.state().endedAt, 0, 'no stop has happened yet')
  // Sentence 2 plays and finishes.
  a.setText('dois')
  at(3_000)
  a.setText('')
  a.settle()
  assert.deepEqual(a.state(), { speaking: false, endedAt: 3_000 })
})

test('queued but not started counts as speaking; the 300 ms starts after the last drains', () => {
  const { a, at } = make()
  a.owe()
  assert.equal(isMuted(a.state(), 50_000), true) // owed, nothing playing yet
  at(10_000)
  a.setText('x')
  a.setText('')
  a.settle()
  assert.equal(isMuted(a.state(), 10_299), true)
  assert.equal(isMuted(a.state(), 10_300), false)
})

test('a cancelled queue is released all at once', () => {
  const { a, at } = make()
  a.owe()
  a.owe()
  a.owe()
  a.setText('um')
  at(5_000)
  a.settle(3)
  a.setText('')
  assert.deepEqual(a.state(), { speaking: false, endedAt: 5_000 })
})

test('settle never goes negative', () => {
  const { a } = make()
  a.settle(5)
  a.owe()
  assert.equal(a.state().speaking, true)
})
