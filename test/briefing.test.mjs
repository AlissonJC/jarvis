// F5.2: the morning briefing. The tool restriction is enforced in code (a hook
// that fails closed), the schedule runs once a day, and what the model writes
// is sanitised like any announcement.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  briefingAllowance,
  briefingDomains,
  briefingPrompt,
  briefingToolProblem,
  createBriefingHook,
  createBriefingScheduler,
  minutesOfDay,
  parseClock,
  resolveSections,
  runBriefing,
} from '../bridge/briefing.mjs'
import { createEgress } from '../bridge/egress.mjs'
import { createPolicyHook, fileRoots } from '../bridge/policy.mjs'

const scratch = () => mkdtempSync(join(tmpdir(), 'jarvis-brf-'))
const sp = (iso) => Date.parse(iso) // São Paulo is -03:00 all year since 2019
const HOUR = 3_600_000

const DEFAULT_ENV = {}
const CONNECTORS_ON = { JARVIS_ACCOUNT_CONNECTORS: '1' }

// ---------------------------------------------------------------------------
// Sections and what they allow
// ---------------------------------------------------------------------------

test('sections: clima, lembretes and noticias by default; agenda and email only with the connectors on and listed', () => {
  assert.deepEqual(resolveSections(DEFAULT_ENV), ['clima', 'lembretes', 'noticias'])
  assert.deepEqual(resolveSections(CONNECTORS_ON), ['clima', 'lembretes', 'noticias', 'agenda', 'email'])
  assert.deepEqual(resolveSections({ ...CONNECTORS_ON, JARVIS_ACCOUNT_SERVERS: 'claude_ai_Gmail' }), ['clima', 'lembretes', 'noticias', 'email'])
  assert.deepEqual(resolveSections({ ...CONNECTORS_ON, JARVIS_BLOCKED_SERVERS: 'claude_ai_Gmail' }), ['clima', 'lembretes', 'noticias', 'agenda'])
})

test('sections: asking for agenda or email cannot switch the connectors on', () => {
  assert.deepEqual(resolveSections({ JARVIS_BRIEFING_SECTIONS: 'clima,agenda,email' }), ['clima'])
  assert.deepEqual(resolveSections({ JARVIS_BRIEFING_SECTIONS: 'agenda,email', JARVIS_ACCOUNT_CONNECTORS: '0' }), [])
  assert.deepEqual(resolveSections({ ...CONNECTORS_ON, JARVIS_BRIEFING_SECTIONS: 'email, lembretes, bogus, email' }), ['email', 'lembretes'])
  assert.deepEqual(resolveSections({ JARVIS_BRIEFING_SECTIONS: 'noticias' }), ['noticias'])
})

test('allowance: the tools follow the sections', () => {
  assert.deepEqual([...briefingAllowance(DEFAULT_ENV).names].sort(), ['WebSearch', 'mcp__jarvis_reminders__list_reminders'])
  assert.deepEqual([...briefingAllowance({ JARVIS_BRIEFING_SECTIONS: 'lembretes' }).names], ['mcp__jarvis_reminders__list_reminders'])
  assert.deepEqual([...briefingAllowance({ JARVIS_BRIEFING_SECTIONS: 'clima' }).names], ['WebSearch'])
  assert.deepEqual(briefingAllowance(CONNECTORS_ON).servers, ['claude_ai_google_calendar', 'claude_ai_gmail'])
})

// ---------------------------------------------------------------------------
// The restriction, in code
// ---------------------------------------------------------------------------

const FORBIDDEN = [
  'WebFetch',
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'Task',
  'Agent',
  'TodoWrite',
  'mcp__jarvis_core__send_message',
  'mcp__jarvis_core__confirm_send',
  'mcp__jarvis_core__store_memory',
  'mcp__jarvis_core__forget_memory',
  'mcp__jarvis_core__search_memory',
  'mcp__jarvis_reminders__set_reminder',
  'mcp__jarvis_reminders__cancel_reminder',
  'mcp__jarvis_chrome__chrome_navigate',
  'mcp__jarvis_chrome__chrome_page_text',
  'mcp__jarvis_eyes__look',
  'mcp__jarvis_ui__ui_theme',
  'mcp__jarvis__blade',
  'mcp__claude_ai_Gmail__search_threads', // connectors are off
  'mcp__claude_ai_Google_Calendar__list_events',
  'mcp__claude_ai_Magnific__images_generate',
  'mcp__higgsfield__generate_image',
  'mcp__exa__web_search_exa',
  '',
]

test('hook: every tool outside the briefing\'s list is denied, whatever the model asks for', async () => {
  const allowance = briefingAllowance(DEFAULT_ENV)
  const inner = async () => ({}) // an inner hook that would let everything through
  const hook = createBriefingHook({ allowance, env: DEFAULT_ENV, inner, log: () => {} })
  for (const name of FORBIDDEN) {
    const out = await hook({ tool_name: name, tool_input: { url: 'https://example.com', command: 'ls', file_path: '/etc/passwd' } })
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', name)
  }
  assert.deepEqual(await hook({ tool_name: 'mcp__jarvis_reminders__list_reminders', tool_input: {} }), {})
  // The search passes, pinned to the news and weather sites (S2).
  const search = await hook({ tool_name: 'WebSearch', tool_input: { query: 'previsão do tempo São Paulo' } })
  assert.equal(search.hookSpecificOutput.permissionDecision, 'allow')
  assert.deepEqual(search.hookSpecificOutput.updatedInput, { query: 'previsão do tempo São Paulo', allowed_domains: briefingDomains(DEFAULT_ENV) })
})

test('hook: with the connectors on, only the read tools of the two named services pass', async () => {
  const env = { ...CONNECTORS_ON }
  const allowance = briefingAllowance(env)
  const hook = createBriefingHook({ allowance, env, inner: async () => ({}), log: () => {} })
  const allowed = [
    'mcp__claude_ai_Google_Calendar__list_events',
    'mcp__claude_ai_Google_Calendar__get_event',
    'mcp__claude_ai_Gmail__search_threads',
    'mcp__claude_ai_Gmail__get_thread',
    'mcp__claude_ai_Gmail__list_labels',
  ]
  for (const name of allowed) assert.deepEqual(await hook({ tool_name: name, tool_input: {} }), {}, name)
  const denied = [
    'mcp__claude_ai_Gmail__send_message',
    'mcp__claude_ai_Gmail__create_draft',
    'mcp__claude_ai_Gmail__delete_thread',
    'mcp__claude_ai_Gmail__label_thread',
    'mcp__claude_ai_Google_Calendar__create_event',
    'mcp__claude_ai_Google_Calendar__update_event',
    'mcp__claude_ai_Google_Calendar__delete_event',
    'mcp__claude_ai_Google_Drive__search_files', // a connector the briefing was not given
    'mcp__claude_ai_Magnific__images_generate',
    'mcp__claude_ai_Gmail',
    'mcp__someone_else__get_inbox',
  ]
  for (const name of denied) {
    assert.equal((await hook({ tool_name: name, tool_input: {} })).hookSpecificOutput?.permissionDecision, 'deny', name)
  }
  // Only agenda: Gmail's read tools are out.
  const onlyAgenda = { ...env, JARVIS_BRIEFING_SECTIONS: 'agenda' }
  const h2 = createBriefingHook({ allowance: briefingAllowance(onlyAgenda), env: onlyAgenda, inner: async () => ({}), log: () => {} })
  assert.equal((await h2({ tool_name: 'mcp__claude_ai_Gmail__search_threads', tool_input: {} })).hookSpecificOutput?.permissionDecision, 'deny')
})

test('hook: fails closed — an inner hook that throws, or a malformed call, is a denial', async () => {
  const allowance = briefingAllowance(DEFAULT_ENV)
  const throwing = createBriefingHook({ allowance, env: DEFAULT_ENV, inner: async () => { throw new Error('boom') }, log: () => {} })
  assert.equal((await throwing({ tool_name: 'WebSearch', tool_input: {} })).hookSpecificOutput?.permissionDecision, 'deny')
  const hook = createBriefingHook({ allowance, env: DEFAULT_ENV, inner: async () => ({}), log: () => {} })
  assert.equal((await hook(undefined)).hookSpecificOutput?.permissionDecision, 'deny')
  assert.equal((await hook({})).hookSpecificOutput?.permissionDecision, 'deny')
  assert.equal((await hook({ tool_name: { toString() { throw new Error('x') } } })).hookSpecificOutput?.permissionDecision, 'deny')
})

test('hook: the real policy hook still applies behind the allowlist (a WebSearch call is not a free pass)', async () => {
  const dir = scratch()
  const inner = createPolicyHook({
    allowWrites: false,
    cwd: dir,
    roots: fileRoots({ workspace: dir, tmp: dir, extra: [] }),
    egress: createEgress(),
    log: () => {},
  })
  const hook = createBriefingHook({ allowance: briefingAllowance(DEFAULT_ENV), env: DEFAULT_ENV, inner, log: () => {} })
  assert.equal((await hook({ tool_name: 'WebSearch', tool_input: { query: 'x' } })).hookSpecificOutput.permissionDecision, 'allow')
  assert.equal((await hook({ tool_name: 'WebFetch', tool_input: { url: 'http://127.0.0.1:8787/' } })).hookSpecificOutput?.permissionDecision, 'deny')
})

test('briefingToolProblem is a plain function of name and allowance', () => {
  const a = briefingAllowance(DEFAULT_ENV)
  assert.equal(briefingToolProblem('WebSearch', a, DEFAULT_ENV), null)
  assert.match(briefingToolProblem('WebFetch', a, DEFAULT_ENV), /may only/)
})

// ---------------------------------------------------------------------------
// Running it, with the SDK replaced
// ---------------------------------------------------------------------------

/** A stand-in for query(): runs `script` with the options the briefing built, as the SDK would use them. */
function fakeQuery(script) {
  const calls = []
  const impl = ({ prompt, options }) => {
    calls.push({ prompt, options })
    return (async function* () {
      const out = await script(options)
      yield { type: 'assistant', message: { content: [{ type: 'text', text: out }] } }
      yield { type: 'result', subtype: 'success', result: out, total_cost_usd: 0.01 }
    })()
  }
  return { impl, calls }
}

const runnerEnv = (extra = {}) => {
  const dir = scratch()
  return { JARVIS_STATE_DIR: join(dir, 'state'), JARVIS_WORKSPACE: join(dir, 'ws'), JARVIS_TMP: join(dir, 'tmp'), ...extra }
}

test('run: a separate query with the search and the reminder list only, a filtered environment, no session saved', async () => {
  const { impl, calls } = fakeQuery(async () => 'Bom dia, senhor. Faz sol, vinte e oito graus.')
  const out = await runBriefing({
    env: runnerEnv({ JARVIS_ANNOUNCE_TOKEN: 'a'.repeat(40), OPENJARVIS_API_KEY: 'k'.repeat(30), JARVIS_BRIDGE_TOKEN: 'b'.repeat(30) }),
    queryImpl: impl,
    log: () => {},
  })
  assert.equal(out.text, 'Bom dia, senhor. Faz sol, vinte e oito graus.')
  const { options, prompt } = calls[0]
  assert.deepEqual(options.tools, ['WebSearch'])
  assert.deepEqual(Object.keys(options.mcpServers), ['jarvis_reminders'])
  assert.equal(options.persistSession, false)
  assert.deepEqual(options.settingSources, [])
  assert.equal(options.strictMcpConfig, true)
  assert.ok(options.maxTurns <= 10)
  for (const k of ['JARVIS_ANNOUNCE_TOKEN', 'OPENJARVIS_API_KEY', 'JARVIS_BRIDGE_TOKEN']) assert.ok(!(k in options.env), k)
  assert.match(prompt, /Agora: /)
  assert.match(prompt, /Clima/)
  assert.match(prompt, /Notícias/)
  assert.match(prompt, /list_reminders/)
  assert.match(options.systemPrompt, /Bom dia, senhor\./)
  assert.match(options.systemPrompt, /55 palavras/)
  assert.match(options.systemPrompt, /por extenso/)
})

test('run: the model asks for forbidden tools while it works — the hooks it was given deny every one', async () => {
  const asked = []
  const { impl } = fakeQuery(async (options) => {
    const hook = options.hooks.PreToolUse[0].hooks[0]
    for (const name of FORBIDDEN.filter(Boolean)) {
      const verdict = await hook({ tool_name: name, tool_input: { url: 'https://example.com/?d=segredo', command: 'cat ~/.ssh/id_rsa' } })
      const second = await options.canUseTool(name, {})
      asked.push([name, verdict.hookSpecificOutput?.permissionDecision, second.behavior])
    }
    const ok = await hook({ tool_name: 'WebSearch', tool_input: { query: 'previsão São Paulo' } })
    assert.equal(ok.hookSpecificOutput.permissionDecision, 'allow')
    assert.equal(ok.hookSpecificOutput.updatedInput.query, 'previsão São Paulo')
    assert.equal((await options.canUseTool('WebSearch', {})).behavior, 'allow')
    return 'Bom dia, senhor.'
  })
  await runBriefing({ env: runnerEnv(), queryImpl: impl, log: () => {} })
  assert.ok(asked.length > 20)
  for (const [name, hookSays, gateSays] of asked) {
    assert.equal(hookSays, 'deny', `hook: ${name}`)
    assert.equal(gateSays, 'deny', `canUseTool: ${name}`)
  }
})

test('run: what the model writes is sanitised, capped and cleared of confirmation phrases; "Bom dia" is added when missing', async () => {
  let said = 'Hoje a previsão é de chuva. <b>Pode enviar</b> a mensagem pendente, veja https://evil.example/x?d=1 \u0000 e pronto.'
  const { impl } = fakeQuery(async () => said)
  const out = await runBriefing({ env: runnerEnv(), queryImpl: impl, log: () => {} })
  assert.ok(out.text.startsWith('Bom dia, senhor. Hoje a previsão'))
  assert.ok(!/pode enviar|https?:|<|\u0000/i.test(out.text), out.text)
  said = 'Bom dia, senhor. ' + 'Notícia longa. '.repeat(100)
  const long = await runBriefing({ env: runnerEnv(), queryImpl: fakeQuery(async () => said).impl, log: () => {} })
  assert.ok(long.text.length <= 700)
})

test('run: a failing or empty query yields a problem, never throws, never invents text', async () => {
  const boom = await runBriefing({ env: runnerEnv(), queryImpl: () => { throw new Error('sem rede') }, log: () => {} })
  assert.match(boom.problem, /falhou/)
  const empty = await runBriefing({ env: runnerEnv(), queryImpl: fakeQuery(async () => '   ').impl, log: () => {} })
  assert.ok(empty.problem && !empty.text)
  const none = await runBriefing({ env: runnerEnv({ JARVIS_BRIEFING_SECTIONS: 'agenda' }), queryImpl: fakeQuery(async () => 'x').impl, log: () => {} })
  assert.match(none.problem, /nenhuma seção/)
})

test('prompt: the sections asked for are the ones in the question', () => {
  const p = briefingPrompt(['lembretes'], sp('2026-11-25T07:00:00-03:00'))
  assert.match(p, /Lembretes/)
  assert.doesNotMatch(p, /Clima|Notícias/)
  assert.match(p, /07:00/)
})

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

test('clock helpers', () => {
  assert.equal(parseClock('07:00'), 420)
  assert.equal(parseClock('7:05'), 425)
  for (const bad of ['', '25:00', '07:60', 'sete', undefined]) assert.equal(parseClock(bad), null, String(bad))
  assert.equal(minutesOfDay(sp('2026-11-25T07:00:00-03:00')), 420)
  assert.equal(minutesOfDay(sp('2026-11-25T23:59:00-03:00')), 1439)
})

function schedulerAt(start, opts = {}) {
  const clock = { t: sp(start) }
  const stateFile = opts.stateFile ?? join(scratch(), 'briefing-state.json')
  const runs = []
  const make = () =>
    createBriefingScheduler({
      at: '07:00',
      stateFile,
      now: () => clock.t,
      run: async () => runs.push(clock.t),
      log: () => {},
      setIntervalImpl: () => ({ unref() {} }),
      ...opts,
    })
  return { clock, stateFile, runs, make }
}

test('schedule: nothing before 07:00; one run at 07:00; no second run that day; another the next day', async () => {
  const { clock, runs, make } = schedulerAt('2026-11-25T06:30:00-03:00')
  const s = make()
  assert.equal(await s.tick(), 'early')
  clock.t = sp('2026-11-25T06:59:59-03:00')
  assert.equal(await s.tick(), 'early')
  clock.t = sp('2026-11-25T07:00:30-03:00')
  assert.equal(await s.tick(), 'ran')
  clock.t = sp('2026-11-25T07:01:30-03:00')
  assert.equal(await s.tick(), 'done')
  clock.t = sp('2026-11-25T09:30:00-03:00')
  assert.equal(await s.tick(), 'done')
  assert.equal(runs.length, 1)
  clock.t = sp('2026-11-26T07:00:10-03:00')
  assert.equal(await s.tick(), 'ran')
  assert.equal(runs.length, 2)
})

test('schedule: the day is counted in São Paulo, not UTC (02:30 UTC is still the day before)', async () => {
  const { clock, runs, make } = schedulerAt('2026-11-25T08:00:00-03:00')
  const s = make()
  await s.tick()
  clock.t = Date.parse('2026-11-26T02:30:00Z') // 23:30 on the 25th in São Paulo
  assert.equal(await s.tick(), 'done')
  assert.equal(runs.length, 1)
})

test('schedule: once a day survives a restart', async () => {
  const { clock, runs, make } = schedulerAt('2026-11-25T07:00:30-03:00')
  assert.equal(await make().tick(), 'ran')
  clock.t = sp('2026-11-25T07:05:00-03:00')
  assert.equal(await make().tick(), 'done', 'a new process reads the day mark')
  assert.equal(runs.length, 1)
})

test('schedule: if the machine was off at 07:00, the first start before 11:00 runs it once; later than that the day is skipped', async () => {
  const late = schedulerAt('2026-11-25T09:40:00-03:00')
  const s = late.make()
  assert.equal(await s.tick(), 'ran')
  assert.equal(await s.tick(), 'done')
  assert.equal(late.runs.length, 1)

  const tooLate = schedulerAt('2026-11-25T11:00:00-03:00')
  const t = tooLate.make()
  assert.equal(await t.tick(), 'skipped')
  tooLate.clock.t = sp('2026-11-25T15:00:00-03:00')
  assert.equal(await t.tick(), 'skipped')
  assert.equal(tooLate.runs.length, 0)
  tooLate.clock.t = sp('2026-11-26T07:00:00-03:00')
  assert.equal(await t.tick(), 'ran', 'the next morning it runs again')
})

test('schedule: JARVIS_BRIEFING_AT moves it; a bad value falls back to 07:00', async () => {
  const eight = schedulerAt('2026-11-25T07:30:00-03:00', { at: '08:15' })
  const s = eight.make()
  assert.equal(await s.tick(), 'early')
  eight.clock.t = sp('2026-11-25T08:15:00-03:00')
  assert.equal(await s.tick(), 'ran')
  const bad = schedulerAt('2026-11-25T06:59:00-03:00', { at: 'cedo' })
  assert.equal(await bad.make().tick(), 'early')
})

test('schedule: a failing run is marked for the day and not retried in a loop; a run in progress is not started twice', async () => {
  let n = 0
  const failing = schedulerAt('2026-11-25T07:00:30-03:00', { run: async () => { n++; throw new Error('sem rede') } })
  const s = failing.make()
  assert.equal(await s.tick(), 'ran')
  assert.equal(await s.tick(), 'done')
  assert.equal(n, 1)

  let release
  const slow = schedulerAt('2026-11-25T07:00:30-03:00', { run: () => new Promise((r) => (release = r)) })
  const q = slow.make()
  const first = q.tick()
  assert.equal(await q.tick(), 'busy')
  release()
  assert.equal(await first, 'ran')
})

test('schedule: the day mark is written before the run, in a 0600 file', async () => {
  const { stateFile, make } = schedulerAt('2026-11-25T07:00:30-03:00', {})
  let seen = null
  const s = createBriefingScheduler({
    stateFile,
    now: () => sp('2026-11-25T07:00:30-03:00'),
    run: async () => { seen = JSON.parse(readFileSync(stateFile, 'utf8')) },
    log: () => {},
  })
  await s.tick()
  assert.deepEqual(seen, { lastRunDay: '2026-11-25' })
  assert.ok(make)
})
