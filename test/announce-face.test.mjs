// F5.1, the face's side: which announcements are accepted, and when one may speak.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HIGH_WAITS_LISTENING_MS,
  LOUD_ROOM_MS,
  announceBlade,
  canPlayNow,
  createAnnounceInbox,
  parseAnnouncement,
} from '../src/lib/announce.ts'

const frame = (over = {}) => ({ type: 'announce', id: 'abc123', text: 'Senhor, lembrete: beber água.', priority: 'high', source: 'lembrete', kind: 'reminder', at: 1, expiresAt: 9e15, ...over })

test('parseAnnouncement: a good frame; defaults for the soft fields; malformed ones are dropped', () => {
  assert.deepEqual(parseAnnouncement(frame()), { id: 'abc123', text: 'Senhor, lembrete: beber água.', priority: 'high', source: 'lembrete', kind: 'reminder', at: 1, expiresAt: 9e15 })
  assert.equal(parseAnnouncement(frame({ priority: 'urgent' })).priority, 'normal')
  for (const bad of [null, 'x', {}, frame({ id: '../x' }), frame({ id: 5 }), frame({ text: '' }), frame({ text: '   ' }), frame({ text: 7 }), frame({ text: 'a'.repeat(2000) })]) {
    assert.equal(parseAnnouncement(bad), null)
  }
})

test('canPlayNow: only at rest; a high one may speak into the follow-up window after a wait, never over a sentence', () => {
  const base = { caption: '', priority: 'normal', waitedMs: 0, micLoud: false }
  assert.equal(canPlayNow({ ...base, phase: 'dormant' }), true)
  for (const phase of ['offline', 'boot', 'waking', 'thinking', 'tooling', 'speaking', 'listening']) {
    assert.equal(canPlayNow({ ...base, phase }), false, phase)
  }
  const high = { ...base, priority: 'high', phase: 'listening' }
  assert.equal(canPlayNow({ ...high, waitedMs: HIGH_WAITS_LISTENING_MS - 1 }), false)
  assert.equal(canPlayNow({ ...high, waitedMs: HIGH_WAITS_LISTENING_MS }), true)
  assert.equal(canPlayNow({ ...high, waitedMs: 999_999, caption: 'estou dizendo uma coisa' }), false, 'not over the user\'s sentence')
  assert.equal(canPlayNow({ ...base, phase: 'listening', waitedMs: 999_999 }), false, 'a normal one never does')
  assert.equal(canPlayNow({ ...high, phase: 'thinking', waitedMs: 999_999 }), false)
})

test('canPlayNow: a loud room delays it by up to ten seconds, then it speaks anyway', () => {
  const base = { caption: '', priority: 'normal', phase: 'dormant', micLoud: true }
  assert.equal(canPlayNow({ ...base, waitedMs: 0 }), false)
  assert.equal(canPlayNow({ ...base, waitedMs: LOUD_ROOM_MS - 1 }), false)
  assert.equal(canPlayNow({ ...base, waitedMs: LOUD_ROOM_MS }), true)
})

test('inbox: dedupes by id, drops what has expired, serves high before normal then oldest', () => {
  const clock = { t: 1_000 }
  const inbox = createAnnounceInbox(() => clock.t)
  assert.equal(inbox.add(parseAnnouncement(frame({ id: 'n1111', priority: 'normal', text: 'um' }))), true)
  clock.t += 10
  assert.equal(inbox.add(parseAnnouncement(frame({ id: 'h2222', priority: 'high', text: 'dois' }))), true)
  clock.t += 10
  assert.equal(inbox.add(parseAnnouncement(frame({ id: 'n3333', priority: 'normal', text: 'tres' }))), true)
  assert.equal(inbox.add(parseAnnouncement(frame({ id: 'n1111' }))), false, 'a re-send while waiting')
  assert.equal(inbox.add(parseAnnouncement(frame({ id: 'x9999', expiresAt: 500 }))), false, 'already out of date')
  assert.equal(inbox.size, 3)
  assert.equal(inbox.next().item.id, 'h2222')
  assert.equal(inbox.next().waitedMs, 10)
  inbox.done('h2222')
  assert.equal(inbox.next().item.id, 'n1111')
  assert.equal(inbox.add(parseAnnouncement(frame({ id: 'h2222' }))), false, 'spoken ones are not accepted again')
})

test('inbox: an interrupted one is released so the bridge may offer it again; an expired one goes quietly', () => {
  const clock = { t: 0 }
  const inbox = createAnnounceInbox(() => clock.t)
  inbox.add(parseAnnouncement(frame({ id: 'r1111', expiresAt: 100 })))
  inbox.release('r1111')
  assert.equal(inbox.add(parseAnnouncement(frame({ id: 'r1111', expiresAt: 100 }))), true)
  clock.t = 200
  assert.equal(inbox.next(), null)
  assert.equal(inbox.size, 0)
})

test('announceBlade: the whole text, escaped, never markup of the sender\'s', () => {
  const blade = announceBlade(parseAnnouncement(frame({ id: 'e1111', kind: 'announce', source: 'meu-script', text: 'a <img src=x onerror=alert(1)> & "b"' })))
  assert.equal(blade.kind, 'markup')
  assert.equal(blade.hold, 'turn')
  assert.ok(!/<img/.test(blade.html), blade.html)
  assert.match(blade.html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;b&quot;/)
  assert.match(blade.html, /meu-script/)
  assert.equal(announceBlade(parseAnnouncement(frame())).title, 'LEMBRETE')
  assert.equal(announceBlade(parseAnnouncement(frame({ kind: 'briefing' }))).title, 'RESUMO DA MANHÃ')
})
