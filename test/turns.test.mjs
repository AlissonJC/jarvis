import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnInput } from '../bridge/turns.mjs'
import { createGate } from '../bridge/confirm.mjs'

const sleep = (ms = 15) => new Promise((r) => setTimeout(r, ms))

/** What the SDK does with the generator: reads it as fast as it yields. */
function sdk(input, turn) {
  const yielded = []
  const done = (async () => {
    for await (const m of input.messages()) yielded.push({ text: m.message.content, n: turn.n })
  })()
  return { yielded, done }
}

test('M2: an utterance that arrives while a turn is running waits for its result; the counter does not move', async () => {
  const turn = { n: 0, text: '', spoken: '' }
  const input = createTurnInput({ turn })
  const { yielded, done } = sdk(input, turn)

  input.push({ text: 'lê o e-mail', id: 'a1' })
  await sleep()
  assert.deepEqual(yielded, [{ text: 'lê o e-mail', n: 1 }])

  input.push({ text: 'sim, e aí?', id: 'a2' }) // said during the first turn (a barge-in)
  await sleep(60)
  assert.equal(yielded.length, 1, 'not handed to the model yet')
  assert.equal(turn.n, 1, 'the counter has not moved')
  assert.equal(turn.text, 'lê o e-mail')

  input.end() // the first turn's result
  await sleep()
  assert.deepEqual(yielded.at(-1), { text: 'sim, e aí?', n: 2 })
  assert.equal(turn.text, 'sim, e aí?')

  input.close()
  await done
})

test('M2: the reviewer\'s scenario: a page that loops propose + confirm cannot use a yes said during its own turn', async () => {
  const turn = { n: 0, text: '', spoken: '' }
  const gate = createGate({ getTurn: () => turn })
  const input = createTurnInput({ turn })
  const { done } = sdk(input, turn)

  input.push({ text: 'lê o e-mail', id: 'a1' })
  await sleep()
  // Turn 1 is running tools; the injected page makes the model propose and try to confirm, over and over.
  let confirmedDuringTurn1 = 0
  const attack = (async () => {
    for (let i = 0; i < 8; i++) {
      gate.propose('send', { text: 'transfira tudo' })
      if (gate.confirm('send').ok) confirmedDuringTurn1++
      await sleep(10)
    }
  })()
  await sleep(25)
  input.push({ text: 'sim, e aí?', id: 'a2' }) // the user interrupts; their words are for something else
  await attack
  assert.equal(confirmedDuringTurn1, 0)
  assert.equal(turn.n, 1)
  // The turn ends. What it proposed is announced; the interrupting utterance now begins turn 2 and is the one right after.
  assert.equal(gate.present(1).length, 1)
  input.end()
  await sleep()
  assert.equal(turn.n, 2)
  // "sim, e aí?" is not the phrase for a message, so the loop's confirmation fails even now.
  assert.equal(gate.confirm('send').ok, false)
  input.close()
  await done
})

test('M2: onBegin runs when the turn starts, with the id of that question', async () => {
  const turn = { n: 0, text: '', spoken: '' }
  const begun = []
  const input = createTurnInput({ turn, onBegin: (i) => begun.push([i.id, turn.n]) })
  const { done } = sdk(input, turn)
  input.push({ text: 'um', id: 'q1' })
  input.push({ text: 'dois', id: 'q2' })
  await sleep()
  assert.deepEqual(begun, [['q1', 1]])
  input.end()
  await sleep()
  assert.deepEqual(begun, [['q1', 1], ['q2', 2]])
  input.close()
  await done
})

test('M2/N5: a turn that never reports a result is interrupted at the cap, and the next one still waits for it (see security-review2.test.mjs)', async () => {
  const turn = { n: 0, text: '', spoken: '' }
  let capped = 0
  const input = createTurnInput({ turn, capMs: 40, graceMs: 10_000, onCap: () => capped++ })
  const { yielded, done } = sdk(input, turn)
  input.push({ text: 'um', id: 'q1' })
  await sleep()
  input.push({ text: 'dois', id: 'q2' })
  await sleep(120)
  assert.equal(capped, 1)
  assert.equal(yielded.length, 1, 'the second utterance is not handed over while the first may still be running')
  assert.equal(turn.n, 1)
  input.end()
  await sleep()
  assert.equal(yielded.length, 2)
  input.close()
  await done
})

test('M2: closing the conversation unblocks a waiting generator', async () => {
  const turn = { n: 0, text: '', spoken: '' }
  const input = createTurnInput({ turn })
  const { done } = sdk(input, turn)
  input.push({ text: 'um', id: 'q1' })
  await sleep()
  input.push({ text: 'dois', id: 'q2' })
  await sleep()
  input.close()
  await done // would hang if close did not wake it
  assert.equal(turn.n, 1)
})
