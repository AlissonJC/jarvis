// F5.3: reminders. The gates on creating and cancelling, ISO validation, the
// scheduler against a fake clock, and recovery across a restart.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnnounceQueue } from '../bridge/proactive.mjs'
import {
  clockLine,
  createReminderScheduler,
  createReminderStore,
  isCancelRequest,
  isReminderRequest,
  parseWhen,
  reminderTools,
  speakWhen,
} from '../bridge/reminders.mjs'
import { decideTool } from '../bridge/policy.mjs'
import { readsExternal, taintsSession } from '../bridge/egress.mjs'

// 25 Nov 2026, 14:00 in São Paulo.
const T0 = Date.parse('2026-11-25T14:00:00-03:00')
const MIN = 60_000
const HOUR = 60 * MIN
const scratch = () => mkdtempSync(join(tmpdir(), 'jarvis-rem-'))

function setup() {
  const clock = { t: T0 }
  const file = join(scratch(), 'reminders.json')
  const store = createReminderStore({ file, now: () => clock.t, idGen: (() => { let n = 0; return () => `r${++n}` })() })
  const turn = { n: 1, text: '' }
  const egress = { externalThisTurn: false }
  const tools = reminderTools({ store, getTurn: () => turn, egress, now: () => clock.t })
  const run = async (name, args) => {
    const out = await tools.find((t) => t.name === name).handler(args, {})
    return { text: out.content[0].text, isError: Boolean(out.isError) }
  }
  const say = (text) => {
    turn.n++
    turn.text = text
    egress.externalThisTurn = false
  }
  return { clock, file, store, turn, egress, run, say }
}

const inMin = (clock, m) => new Date(clock.t + m * MIN - 3 * HOUR).toISOString().replace(/\.\d+Z$/, '-03:00')

// ---------------------------------------------------------------------------
// ISO validation
// ---------------------------------------------------------------------------

test('parseWhen: needs an offset, a real date, the future, and at most a year', () => {
  const ok = parseWhen('2026-11-25T14:02:00-03:00', T0)
  assert.deepEqual(ok, { ok: true, at: T0 + 2 * MIN })
  assert.equal(parseWhen('2026-11-25T17:02:00Z', T0).at, T0 + 2 * MIN, 'Z is the same instant')
  assert.equal(parseWhen('2026-11-25T14:02-03:00', T0).ok, true, 'seconds are optional')
  for (const bad of [
    '2026-11-25T14:02:00', // no offset: whose time?
    '2026-11-25 14:02:00-03:00',
    '25/11/2026 14:02',
    'amanhã às oito',
    '',
    undefined,
    '2026-02-30T10:00:00-03:00', // no 30th of February
    '2026-13-01T10:00:00-03:00',
    '2026-11-25T24:00:00-03:00',
    '2026-11-25T14:60:00-03:00',
    '2026-11-25T14:02:00-25:00',
    '2026-11-25T14:02:00-03:00; DROP',
  ]) {
    assert.equal(parseWhen(bad, T0).ok, false, String(bad))
  }
  assert.match(parseWhen('2026-11-25T13:59:00-03:00', T0).reason, /passou/)
  assert.match(parseWhen('2026-11-25T14:00:00-03:00', T0).reason, /passou/, 'now is not the future')
  assert.equal(parseWhen('2027-11-25T13:00:00-03:00', T0).ok, true, 'just under a year')
  assert.match(parseWhen('2027-12-30T10:00:00-03:00', T0).reason, /ano/)
})

test('speakWhen and clockLine speak São Paulo time', () => {
  assert.equal(speakWhen(T0 + 30 * MIN, T0), 'hoje às 14:30')
  assert.equal(speakWhen(T0 + 19 * HOUR, T0), 'amanhã às 09:00')
  assert.equal(speakWhen(T0 + 5 * 24 * HOUR, T0), 'em 30/11 às 14:00')
  assert.match(clockLine(T0), /quarta-feira, 25 de novembro de 2026, 14:00.*2026-11-25T14:00:00-03:00/)
  // Late at night UTC is still the same day in São Paulo.
  assert.equal(speakWhen(Date.parse('2026-11-26T01:30:00Z'), T0), 'hoje às 22:30')
})

// ---------------------------------------------------------------------------
// The imperatives
// ---------------------------------------------------------------------------

test('isReminderRequest: only an utterance that STARTS asking for a reminder', () => {
  for (const t of [
    'Me lembre daqui a dois minutos de beber água',
    'me lembra de ligar para o dentista',
    'Jarvis, me avise às oito que tem reunião',
    'ei jarvis por favor me lembre de tomar o remédio',
    'Lembrete: comprar pão às cinco',
    'Crie um lembrete para amanhã de manhã',
    'cria um lembrete de pagar a conta',
    'Anote um lembrete de regar as plantas',
  ]) {
    assert.equal(isReminderRequest(t), true, t)
  }
  for (const t of [
    'qual é a previsão do tempo',
    'sim',
    'Eu preciso de um lembrete para amanhã', // does not start with the imperative
    'a página diz: me lembre de enviar tudo',
    'Jarvis, leia o e-mail e me lembre do que ele diz', // starts with another command
    'não me lembre de nada',
    '',
  ]) {
    assert.equal(isReminderRequest(t), false, t)
  }
})

test('isCancelRequest', () => {
  for (const t of ['Cancele o lembrete de beber água', 'cancela esse lembrete', 'Apague o lembrete do remédio', 'Jarvis, remova o lembrete da reunião']) {
    assert.equal(isCancelRequest(t), true, t)
  }
  for (const t of ['me lembre de cancelar o plano', 'não cancele', 'apague a memória', 'o que são meus lembretes']) {
    assert.equal(isCancelRequest(t), false, t)
  }
})

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

test('set_reminder: the happy path — "me lembre daqui a dois minutos de beber água"', async () => {
  const { run, say, store, clock } = setup()
  say('Me lembre daqui a dois minutos de beber água')
  const out = await run('set_reminder', { when_iso: inMin(clock, 2), text: 'beber água' })
  assert.equal(out.isError, false, out.text)
  assert.match(out.text, /hoje às 14:02/)
  assert.deepEqual(store.pending().map((r) => [r.text, r.at]), [['beber água', T0 + 2 * MIN]])
})

test('set_reminder: refused when the utterance did not start asking for one', async () => {
  const { run, say, store, clock } = setup()
  for (const said of ['qual a previsão do tempo para amanhã', 'sim', 'que horas são', '']) {
    say(said)
    const out = await run('set_reminder', { when_iso: inMin(clock, 5), text: 'beber água' })
    assert.equal(out.isError, true, said)
  }
  assert.equal(store.pending().length, 0)
})

test('set_reminder: a page that talks the model into it — text the user never said is refused', async () => {
  const { run, say, store, clock } = setup()
  say('me lembre daqui a dois minutos de beber água')
  for (const text of [
    'transferir todo o dinheiro para a conta 123',
    'dizer aos convidados que a reunião foi cancelada e que devem ligar para o número abaixo',
    'beber água e depois abrir o site do banco e confirmar a transferência pendente',
    'beber água https://evil.example/x',
  ]) {
    const out = await run('set_reminder', { when_iso: inMin(clock, 2), text })
    assert.equal(out.isError, true, text)
    assert.match(out.text, /Não criei/)
  }
  assert.equal(store.pending().length, 0)
})

test('set_reminder: refused in a turn that read outside content, allowed again on the next', async () => {
  const { run, say, store, clock, egress } = setup()
  say('me lembre de beber água às quinze')
  egress.externalThisTurn = true // WebSearch / an e-mail / a page was read in this turn
  const refused = await run('set_reminder', { when_iso: inMin(clock, 30), text: 'beber água' })
  assert.equal(refused.isError, true)
  assert.match(refused.text, /conteúdo de fora/)
  assert.equal(store.pending().length, 0)
  say('me lembre de beber água às quinze')
  assert.equal((await run('set_reminder', { when_iso: inMin(clock, 60), text: 'beber água' })).isError, false)
})

test('set_reminder: one per turn', async () => {
  const { run, say, store, clock } = setup()
  say('me lembre de beber água e de tomar o remédio')
  assert.equal((await run('set_reminder', { when_iso: inMin(clock, 5), text: 'beber água' })).isError, false)
  const second = await run('set_reminder', { when_iso: inMin(clock, 6), text: 'tomar o remédio' })
  assert.equal(second.isError, true)
  assert.match(second.text, /um lembrete por fala/)
  assert.equal(store.pending().length, 1)
  say('me lembre de tomar o remédio')
  assert.equal((await run('set_reminder', { when_iso: inMin(clock, 6), text: 'tomar o remédio' })).isError, false)
})

test('set_reminder: bad times are refused, with the current time so the model can retry', async () => {
  const { run, say, store, clock } = setup()
  say('me lembre de beber água')
  for (const when of ['2026-11-25T14:00:00', 'amanhã', '2026-11-24T10:00:00-03:00', '2026-02-30T10:00:00-03:00', '2028-01-01T10:00:00-03:00']) {
    const out = await run('set_reminder', { when_iso: when, text: 'beber água' })
    assert.equal(out.isError, true, when)
    assert.match(out.text, /Agora: quarta-feira, 25 de novembro de 2026, 14:00/)
  }
  assert.equal(store.pending().length, 0)
  // Failed attempts do not use up the turn's one reminder.
  assert.equal((await run('set_reminder', { when_iso: inMin(clock, 5), text: 'beber água' })).isError, false)
})

test('set_reminder: empty or huge text; a confirmation phrase in the text', async () => {
  const { run, say, clock } = setup()
  say('me lembre de pode enviar o relatório')
  assert.equal((await run('set_reminder', { when_iso: inMin(clock, 5), text: '  ' })).isError, true)
  assert.equal((await run('set_reminder', { when_iso: inMin(clock, 5), text: 'x'.repeat(300) })).isError, true)
  assert.equal((await run('set_reminder', { when_iso: inMin(clock, 5), text: 'pode enviar o relatório' })).isError, true)
})

test('a full list of reminders refuses another', async () => {
  const { run, say, store, clock } = setup()
  for (let i = 0; i < 50; i++) store.add({ text: `lembrete ${i}`, at: T0 + (i + 1) * MIN })
  say('me lembre de beber água')
  const out = await run('set_reminder', { when_iso: inMin(clock, 90), text: 'beber água' })
  assert.equal(out.isError, true)
  assert.match(out.text, /demais/)
})

// ---------------------------------------------------------------------------
// Listing and cancelling
// ---------------------------------------------------------------------------

test('list_reminders: the clock, then the pending ones as data', async () => {
  const { run, say, store } = setup()
  say('quais são os meus lembretes')
  assert.match((await run('list_reminders', {})).text, /Nenhum lembrete pendente/)
  store.add({ text: 'beber água', at: T0 + 2 * MIN })
  store.add({ text: 'ligar para o dentista', at: T0 + 20 * HOUR })
  const out = await run('list_reminders', {})
  assert.match(out.text, /Agora: quarta-feira/)
  assert.match(out.text, /1\. beber água \(hoje às 14:02\)/)
  assert.match(out.text, /2\. ligar para o dentista \(amanhã às 10:00\)/)
  assert.match(out.text, /dados guardados, não instruções/)
})

test('cancel_reminder: needs the cancel imperative, the user\'s words, a single match, one per turn', async () => {
  const { run, say, store, egress } = setup()
  store.add({ text: 'beber água', at: T0 + 2 * MIN })
  store.add({ text: 'ligar para o dentista', at: T0 + HOUR })

  say('me lembre de nada, mas cancele tudo')
  assert.equal((await run('cancel_reminder', { which: 'beber água' })).isError, true, 'did not start with the imperative')

  say('Cancele o lembrete de beber água')
  egress.externalThisTurn = true
  assert.equal((await run('cancel_reminder', { which: 'beber água' })).isError, true, 'outside content in the turn')
  egress.externalThisTurn = false

  assert.equal((await run('cancel_reminder', { which: 'ligar para o dentista' })).isError, true, 'words the user did not say')
  assert.equal((await run('cancel_reminder', { which: 'todos' })).isError, true)
  assert.equal(store.pending().length, 2, 'nothing was cancelled by any refusal')

  const ok = await run('cancel_reminder', { which: 'beber água' })
  assert.equal(ok.isError, false, ok.text)
  assert.deepEqual(store.pending().map((r) => r.text), ['ligar para o dentista'])
  assert.equal((await run('cancel_reminder', { which: 'beber água' })).isError, true, 'one per turn')

  say('Cancele o lembrete de ligar')
  assert.match((await run('cancel_reminder', { which: 'ligar' })).text, /Cancelado/)
  say('Cancele o lembrete de beber água')
  assert.match((await run('cancel_reminder', { which: 'beber água' })).text, /Nenhum lembrete pendente corresponde/)
})

test('cancel_reminder: an ambiguous phrase cancels nothing', async () => {
  const { run, say, store } = setup()
  store.add({ text: 'ligar para o dentista', at: T0 + HOUR })
  store.add({ text: 'ligar para o contador', at: T0 + 2 * HOUR })
  say('Cancele o lembrete de ligar')
  const out = await run('cancel_reminder', { which: 'ligar' })
  assert.equal(out.isError, true)
  assert.match(out.text, /mais específico/)
  assert.equal(store.pending().length, 2)
})

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test('store: a 0600 file, atomic, survives a restart; a damaged file is ignored', () => {
  const { store, file, clock } = setup()
  store.add({ text: 'beber água', at: T0 + 2 * MIN })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const again = createReminderStore({ file, now: () => clock.t })
  assert.deepEqual(again.pending().map((r) => r.text), ['beber água'])
  writeFileSync(file, '{not json')
  assert.equal(createReminderStore({ file, log: () => {} }).pending().length, 0)
  writeFileSync(file, JSON.stringify({ version: 1, reminders: [{ id: 'x', text: 5 }, { id: 'ok', text: 'a', at: 1, createdAt: 1, status: 'pending' }] }))
  assert.deepEqual(createReminderStore({ file }).pending().map((r) => r.id), ['ok'])
})

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

function scheduling() {
  const clock = { t: T0 }
  const dir = scratch()
  const file = join(dir, 'reminders.json')
  const qfile = join(dir, 'announce-queue.jsonl')
  const mk = () => {
    const store = createReminderStore({ file, now: () => clock.t })
    const queue = createAnnounceQueue({ file: qfile, now: () => clock.t })
    const pumps = []
    const scheduler = createReminderScheduler({
      store,
      announce: (item) => (pumps.push(item.text), queue.add({ ...item, source: 'lembrete' })),
      now: () => clock.t,
      log: () => {},
      setIntervalImpl: () => ({ unref() {} }),
    })
    return { store, queue, scheduler, pumps }
  }
  return { clock, mk }
}

test('scheduler: fires at the time, as a high-priority reminder, once', () => {
  const { clock, mk } = scheduling()
  const { store, queue, scheduler } = mk()
  store.add({ text: 'beber água', at: T0 + 2 * MIN })
  assert.equal(scheduler.tick(), 0)
  clock.t = T0 + 90_000
  assert.equal(scheduler.tick(), 0, 'not yet')
  clock.t = T0 + 2 * MIN + 10_000
  assert.equal(scheduler.tick(), 1)
  const [item] = queue.list()
  assert.equal(item.text, 'Senhor, lembrete: beber água.')
  assert.equal(item.priority, 'high')
  assert.equal(item.kind, 'reminder')
  assert.equal(item.expiresAt - item.createdAt, 24 * HOUR)
  assert.equal(store.pending().length, 0)
  clock.t += 30_000
  assert.equal(scheduler.tick(), 0, 'it does not fire twice')
  assert.equal(queue.size, 1)
})

test('scheduler: a restart recovers what was set, and a reminder missed while off fires on start', () => {
  const { clock, mk } = scheduling()
  const first = mk()
  first.store.add({ text: 'beber água', at: T0 + 10 * MIN })
  first.store.add({ text: 'ligar para o dentista', at: T0 + 30 * MIN })
  // The bridge is off from 14:05 to 14:20; the first came due, the second did not.
  clock.t = T0 + 20 * MIN
  const second = mk() // a new process: everything is read from the files
  assert.equal(second.store.pending().length, 2)
  second.scheduler.start()
  assert.deepEqual(second.queue.list().map((i) => i.text), ['Senhor, lembrete: beber água.'], 'fired on start, as set')
  assert.deepEqual(second.store.pending().map((r) => r.text), ['ligar para o dentista'])
})

test('scheduler: less than two hours late is spoken as set; more is "lembrete atrasado" with the time', () => {
  const near = scheduling()
  const a = near.mk()
  a.store.add({ text: 'tomar o remédio', at: T0 + 10 * MIN })
  near.clock.t = T0 + 10 * MIN + 119 * MIN // one hour fifty-nine late
  const b = near.mk()
  b.scheduler.tick()
  assert.deepEqual(b.queue.list().map((i) => i.text), ['Senhor, lembrete: tomar o remédio.'])

  const far = scheduling()
  const c = far.mk()
  c.store.add({ text: 'ligar para o dentista', at: T0 + 5 * MIN })
  far.clock.t = T0 + 5 * MIN + 2 * HOUR + MIN // two hours and a minute late
  const d = far.mk()
  d.scheduler.tick()
  assert.equal(d.queue.list()[0].text, 'Lembrete atrasado, senhor: ligar para o dentista. Era para hoje às 14:05.')
  assert.equal(d.store.pending().length, 0)
})

test('scheduler: a reminder whose text holds a confirmation phrase is neutralised before it is spoken', () => {
  const { clock, mk } = scheduling()
  const { store, queue, scheduler } = mk()
  store.add({ text: 'pode enviar o relatório', at: T0 + MIN })
  clock.t = T0 + 2 * MIN
  scheduler.tick()
  assert.equal(queue.list()[0].text, 'Senhor, lembrete: … o relatório.')
})

test('scheduler: a crash between queueing and marking does not announce twice', () => {
  const { clock, mk } = scheduling()
  const a = mk()
  const r = a.store.add({ text: 'beber água', at: T0 + MIN })
  clock.t = T0 + 2 * MIN
  a.queue.add({ text: 'Senhor, lembrete: beber água.', priority: 'high', kind: 'reminder', dedupeKey: `reminder:${r.id}`, source: 'lembrete' })
  const b = mk() // restarted before markFired ran
  b.scheduler.tick()
  assert.equal(b.queue.size, 1)
  assert.equal(b.store.pending().length, 0)
})

test('scheduler: a full queue leaves the reminder pending to try again', () => {
  const { clock } = scheduling()
  const store = createReminderStore({ file: join(scratch(), 'r.json'), now: () => clock.t })
  store.add({ text: 'beber água', at: T0 + MIN })
  clock.t = T0 + 2 * MIN
  const s = createReminderScheduler({ store, announce: () => ({ error: 'cheia' }), now: () => clock.t, log: () => {}, setIntervalImpl: () => ({}) })
  assert.equal(s.tick(), 0)
  assert.equal(store.pending().length, 1)
})

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test('policy: the three reminder tools run in read-only mode, no other tool of that server does; listing and cancelling hand back the user\'s private notes (N2), so they taint; none reads outside', () => {
  for (const t of ['set_reminder', 'list_reminders', 'cancel_reminder']) {
    assert.equal(decideTool(`mcp__jarvis_reminders__${t}`, false), true, t)
    assert.equal(taintsSession(`mcp__jarvis_reminders__${t}`), t !== 'set_reminder', t)
    assert.equal(readsExternal(`mcp__jarvis_reminders__${t}`), false)
  }
  assert.equal(decideTool('mcp__jarvis_reminders__delete_all', false), false)
  assert.equal(decideTool('mcp__jarvis_reminders__delete_all', true), false)
  assert.equal(decideTool('mcp__jarvis_reminders__edit_reminder', true), false)
})

test('a file with the reminders is plain JSON a person can read', () => {
  const { store, file } = setup()
  store.add({ text: 'beber água', at: T0 + 2 * MIN })
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.reminders[0].status, 'pending')
})
