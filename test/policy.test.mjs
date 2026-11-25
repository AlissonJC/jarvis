import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NAVIGATE_TOOL, builtinTools, checkToolUse, decideTool, fetchTargetProblem, fileRoots, keyProblem, navigationFinalProblem,
  navigationVerdict, serverRefusal, typeProblem,
} from '../bridge/policy.mjs'
import { createGate } from '../bridge/confirm.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'jarvis-ws-'))
const jarvisTmp = mkdtempSync(join(tmpdir(), 'jarvis-tmp-'))
const roots = fileRoots({ workspace, tmp: jarvisTmp })
const ctx = (allowWrites = false) => ({ allowWrites, cwd: workspace, roots })
const allowed = (name, input, w) => checkToolUse(name, input, ctx(w)).allow

test('decideTool keeps its existing verdicts', () => {
  assert.equal(decideTool('Read'), true)
  assert.equal(decideTool('Bash'), false)
  assert.equal(decideTool('Bash', true), true)
  assert.equal(decideTool('mcp__jarvis__display'), true)
  assert.equal(decideTool('mcp__someserver__list_devices'), true)
  assert.equal(decideTool('mcp__someserver__install_apk'), false)
  assert.equal(decideTool('mcp__higgsfield__generate_image'), true)
  assert.equal(decideTool('mcp__elevenlabs__make_outbound_call'), false)
  assert.equal(decideTool('SomeFutureBuiltin'), false)
})

test('read-only mode refuses a shell command the CLI would auto-approve', () => {
  // `cat` is what the CLI's own classifier runs without asking canUseTool.
  assert.equal(allowed('Bash', { command: 'cat ~/.ssh/id_rsa' }), false)
  assert.equal(allowed('Bash', { command: 'ls' }), false)
  assert.equal(allowed('Bash', { command: 'ls' }, true), true)
})

test('file tools are confined to the workspace and JARVIS\'s own temp directory', () => {
  writeFileSync(join(workspace, 'note.txt'), 'hi')
  assert.equal(allowed('Read', { file_path: join(workspace, 'note.txt') }), true)
  assert.equal(allowed('Read', { file_path: 'note.txt' }), true) // relative to cwd
  assert.equal(allowed('Read', { file_path: join(jarvisTmp, 'shot.png') }), true)
  // M4: the system temp directory holds other programs' files, other Claude Code sessions included.
  assert.equal(allowed('Read', { file_path: join(tmpdir(), 'shot.png') }), false)
  assert.equal(allowed('Read', { file_path: '/tmp/claude-1000/-home-x/some-session/scratchpad/notes.txt' }), false)
  assert.equal(allowed('Grep', { pattern: 'x', path: '/tmp' }), false)
  assert.equal(allowed('Glob', { pattern: '*', path: tmpdir() }), false)
  assert.equal(allowed('Read', { file_path: join(homedir(), '.bashrc') }), false)
  assert.equal(allowed('Read', { file_path: '~/.claude/.credentials.json' }), false)
  assert.equal(allowed('Read', { file_path: '/etc/passwd' }), false)
  assert.equal(allowed('Read', { file_path: join(workspace, '..', '..', 'etc', 'passwd') }), false)
  assert.equal(allowed('Grep', { pattern: 'x', path: '/home' }), false)
  assert.equal(allowed('Glob', { pattern: '**/*' }), true) // no path = cwd
})

test('a symlink inside the workspace cannot point the read elsewhere', () => {
  const link = join(workspace, 'innocent.png')
  try {
    symlinkSync('/etc/hosts', link)
  } catch {
    return // no symlinks on this filesystem
  }
  assert.equal(allowed('Read', { file_path: link }), false)
})

test('a dangling symlink is judged by where it points, not where it sits', () => {
  const outside = mkdtempSync(join(homedir(), '.jarvis-test-outside-'))
  const link = join(workspace, 'dangling.txt')
  try {
    symlinkSync(join(outside, 'would-be-created.txt'), link)
  } catch {
    return // no symlinks on this filesystem
  }
  try {
    assert.equal(allowed('Write', { file_path: link }, true), false)
    assert.equal(allowed('Read', { file_path: link }), false)
    const loop = join(workspace, 'loop')
    symlinkSync(loop, loop)
    assert.equal(allowed('Read', { file_path: loop }), false)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('credentials stay refused even when the roots include home', () => {
  const wide = { allowWrites: false, cwd: workspace, roots: fileRoots({ workspace, extra: [homedir()] }) }
  const ok = (p) => checkToolUse('Read', { file_path: p }, wide).allow
  assert.equal(ok(join(homedir(), 'Pictures', 'cat.png')), true)
  assert.equal(ok(join(homedir(), '.ssh', 'id_ed25519')), false)
  assert.equal(ok(join(homedir(), '.claude', '.credentials.json')), false)
  assert.equal(ok(join(homedir(), '.claude.json')), false)
  // Case-insensitive volumes (macOS, Windows): ~/.SSH is ~/.ssh.
  assert.equal(ok(join(homedir(), '.SSH', 'config')), false)
  assert.equal(ok(join(homedir(), '.Aws', 'credentials')), false)
  assert.equal(ok(join(homedir(), 'project', '.env')), false)
  assert.equal(ok(join(homedir(), 'project', '.env.local')), false)
  assert.equal(ok(join(homedir(), 'certs', 'server.pem')), false)
})

test('writes are confined too, when writes are on', () => {
  mkdirSync(join(workspace, 'out'), { recursive: true })
  assert.equal(allowed('Write', { file_path: join(workspace, 'out', 'a.txt') }, true), true)
  assert.equal(allowed('Write', { file_path: join(homedir(), 'a.txt') }, true), false)
  assert.equal(allowed('Edit', { file_path: '/etc/hosts' }, true), false)
  assert.equal(allowed('Write', { file_path: join(workspace, 'a.txt') }, false), false)
})

test('WebFetch cannot be pointed at the LAN, loopback or cloud metadata', () => {
  assert.equal(allowed('WebFetch', { url: 'https://example.com/a' }), true)
  assert.equal(allowed('WebFetch', { url: 'http://127.0.0.1:8787/file?path=/x.png' }), false)
  assert.equal(allowed('WebFetch', { url: 'http://169.254.169.254/latest/meta-data/' }), false)
  assert.equal(allowed('WebFetch', { url: 'http://192.168.1.1/' }), false)
  assert.equal(allowed('WebFetch', { url: 'http://printer.local/' }), false)
  assert.equal(allowed('WebFetch', { url: 'file:///etc/passwd' }), false)
})

test('WebFetch names that resolve to private addresses are caught', async () => {
  const to = (address) => async () => [{ address, family: address.includes(':') ? 6 : 4 }]
  assert.match(await fetchTargetProblem('https://rebind.example/', to('127.0.0.1')), /private address/)
  assert.match(await fetchTargetProblem('https://rebind.example/', to('::1')), /private address/)
  assert.match(await fetchTargetProblem('https://intranet.example/', to('10.1.2.3')), /private address/)
  assert.equal(await fetchTargetProblem('https://example.com/', to('93.184.215.14')), null)
  assert.match(await fetchTargetProblem('http://127.0.0.1/'), /blocked host/)
})

test('only the built-ins JARVIS uses are offered', () => {
  const ro = builtinTools(false)
  assert.deepEqual(ro.filter((t) => ['Bash', 'Write', 'Edit'].includes(t)), [])
  for (const absent of ['Agent', 'Task', 'CronCreate', 'RemoteTrigger', 'SendMessage', 'AskUserQuestion', 'Skill']) {
    assert.ok(!ro.includes(absent), `${absent} should not be offered`)
    assert.ok(!builtinTools(true).includes(absent), `${absent} should not be offered with writes`)
  }
  assert.ok(builtinTools(true).includes('Bash'))
})

// ------------------------------------------------------------------- F4: servers

/** Run `fn` with some env vars set, restoring them after. */
const withEnv = (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
const clean = { JARVIS_ACCOUNT_SERVERS: undefined, JARVIS_BLOCKED_SERVERS: undefined, JARVIS_NAV_ALLOW: undefined }

test('jarvis_core is judged tool by tool, not by verb', () => {
  withEnv(clean, () => {
    for (const t of ['search_memory', 'store_memory', 'memory_stats', 'ask_local_model', 'list_channels', 'send_message', 'confirm_send']) {
      assert.equal(decideTool(`mcp__jarvis_core__${t}`, false), true, t)
      assert.equal(decideTool(`mcp__jarvis_core__${t}`, true), true, t)
    }
    // Not on the list: does not run, even with writes on.
    assert.equal(decideTool('mcp__jarvis_core__delete_memory', true), false)
    assert.equal(decideTool('mcp__jarvis_core__anything_else', true), false)
  })
})

test('the default account allowlist lets mail, calendar and drive reads through, and keeps their writes behind JARVIS_ALLOW_WRITES', () => {
  withEnv(clean, () => {
    assert.equal(decideTool('mcp__claude_ai_Gmail__search_threads', false), true)
    assert.equal(decideTool('mcp__claude_ai_Google_Calendar__list_events', false), true)
    assert.equal(decideTool('mcp__claude_ai_Google_Drive__read_file_content', false), true)
    assert.equal(decideTool('mcp__claude_ai_Gmail__create_draft', false), false)
    assert.equal(decideTool('mcp__claude_ai_Gmail__create_draft', true), true)
    assert.equal(decideTool('mcp__claude_ai_Gmail__send_message', false), false)
  })
})

test('Magnific and any unlisted account connector can never run, even with writes on', () => {
  withEnv(clean, () => {
    for (const w of [false, true]) {
      assert.equal(decideTool('mcp__claude_ai_Magnific__images_generate', w), false)
      assert.equal(decideTool('mcp__claude_ai_Magnific__account_balance', w), false)
      assert.equal(decideTool('mcp__claude_ai_Magnific__video_generate', w), false)
      assert.equal(decideTool('mcp__claude_ai_Slack__send_message', w), false)
      assert.equal(decideTool('mcp__claude_ai_Notion__search', w), false)
    }
    const r = checkToolUse('mcp__claude_ai_Magnific__images_generate', { prompt: 'a cat' }, ctx(true))
    assert.equal(r.allow, false)
    assert.match(r.reason, /permanently disabled/)
    assert.match(checkToolUse('mcp__claude_ai_Notion__search', {}, ctx(true)).reason, /not on the list/)
  })
})

test('a blocked server stays blocked even when someone also allowlists it', () => {
  withEnv({ ...clean, JARVIS_ACCOUNT_SERVERS: 'claude_ai_Gmail,claude_ai_Magnific' }, () => {
    assert.equal(decideTool('mcp__claude_ai_Magnific__images_generate', true), false)
    assert.equal(decideTool('mcp__claude_ai_Gmail__search_threads', false), true)
  })
})

test('JARVIS_ACCOUNT_SERVERS and JARVIS_BLOCKED_SERVERS change the lists', () => {
  withEnv({ ...clean, JARVIS_ACCOUNT_SERVERS: 'claude_ai_Gmail' }, () => {
    assert.equal(decideTool('mcp__claude_ai_Google_Drive__list_files', false), false)
    assert.equal(decideTool('mcp__claude_ai_Gmail__search_threads', false), true)
  })
  withEnv({ ...clean, JARVIS_ACCOUNT_SERVERS: '' }, () => {
    assert.equal(decideTool('mcp__claude_ai_Gmail__search_threads', false), false)
  })
  withEnv({ ...clean, JARVIS_BLOCKED_SERVERS: 'claude_ai_Gmail' }, () => {
    assert.equal(decideTool('mcp__claude_ai_Gmail__search_threads', true), false)
  })
})

test('servers from the user config and the built-in jarvis ones are not touched by the account rules', () => {
  withEnv(clean, () => {
    assert.equal(decideTool('mcp__exa__web_search_exa', false), true)
    assert.equal(decideTool('mcp__someserver__list_devices', false), true)
    assert.equal(decideTool('mcp__jarvis__display', false), true)
    assert.equal(decideTool('mcp__jarvis_ui__ui_theme', false), true)
    assert.equal(decideTool('mcp__jarvis_eyes__look', false), true)
  })
})

// ------------------------------------------------------------------- F4: navigation

const NAV = 'mcp__jarvis_chrome__chrome_navigate'
const nav = (url, w = false, gate) => checkToolUse(NAV, { url }, { ...ctx(w), gate })

test('navigation: the default sites open, each as one exact host', () => {
  withEnv(clean, () => {
    for (const url of [
      'https://www.google.com/search?q=previs%C3%A3o+do+tempo', 'https://google.com/', 'https://www.google.com/', 'https://pt.wikipedia.org/wiki/Brasil',
      'https://www.youtube.com/results?search_query=jazz', 'https://youtube.com/watch?v=abc',
      'https://g1.globo.com/', 'https://www.folha.uol.com.br/', 'https://www1.folha.uol.com.br/mundo/', 'https://www.bbc.com/portuguese', 'http://www.bbc.co.uk/news',
      'back', 'forward', 'BACK', 'www.wikipedia.org',
    ]) {
      assert.equal(nav(url).allow, true, url)
    }
    // github.com left the default list with the N6 review: a signed-in browser plus click and type could post to an issue of the attacker's.
    for (const url of ['https://accounts.google.com/', 'https://mail.google.com/mail', 'https://docs.google.com/', 'https://google.com.evil.io/', 'https://github.com/anthropics']) {
      assert.equal(nav(url).allow, false, url)
    }
  })
})

test('M3: no wildcard subdomains: gist and other hosts that carry somebody else\'s content do not open by themselves', () => {
  withEnv(clean, () => {
    for (const url of [
      'https://gist.github.com/attacker/abc', 'https://attacker.github.com/', 'https://raw.github.com/x', 'https://abandoned.youtube.com/',
      'https://sub.wikipedia.org/', 'https://news.bbc.co.uk/', 'https://anything.weather.com/', 'https://x.g1.globo.com/',
    ]) {
      assert.equal(nav(url).allow, false, url)
    }
  })
})

test('M3: google opens only as a search or its front page; the open redirectors never open', () => {
  withEnv(clean, () => {
    // The reviewer's probe: all of these were allowed.
    for (const url of [
      'https://www.google.com/amp/s/evil.example/' + 'A'.repeat(100), 'https://www.google.com/url?q=https://evil.example/x',
      'https://youtube.com/redirect?q=https://evil.example', 'https://www.youtube.com/attribution_link?u=%2F%2Fevil.example',
      'https://www.google.com/imgres?imgurl=https://evil.example/x.png', 'https://www.google.com/aclk?sa=l&adurl=https://evil.example',
      'https://www.google.com/travel/clk?pc=x', 'https://www.google.com/maps/dir/a/b',
    ]) {
      assert.equal(nav(url).allow, false, url)
      assert.equal(nav(url, true, createGate({ getTurn: () => ({ n: 1, text: '' }) })).allow, false, `${url} (writes on)`)
    }
    assert.equal(nav('https://www.google.com/search?q=gatos').allow, true)
    assert.equal(nav('https://www.google.com/search/about').allow, false)
  })
})

test('M3: the whole address is capped at 300 characters, path included', () => {
  withEnv(clean, () => {
    assert.equal(nav('https://en.wikipedia.org/wiki/' + 'a'.repeat(250)).allow, true)
    assert.equal(nav('https://en.wikipedia.org/wiki/' + 'a'.repeat(300)).allow, false)
    assert.equal(nav('en.wikipedia.org/' + 'x'.repeat(5000)).allow, false)
    assert.equal(nav('https://www.google.com/amp/s/evil.example/' + 'A'.repeat(3000), true).allow, false)
    assert.equal(nav('https://exemplo-qualquer.xyz/' + 'z'.repeat(400), true, createGate({ getTurn: () => ({ n: 1, text: '' }) })).allow, false)
  })
})

test('M3: a listed site that redirects somewhere else is sent back', () => {
  const ok = (final, asked) => navigationFinalProblem(final, asked)
  assert.equal(ok('https://github.com/anthropics', 'https://github.com/anthropics'), null)
  assert.equal(ok('https://www.youtube.com/', 'https://youtube.com/'), null, 'listed to listed')
  assert.equal(ok('https://www.google.com/sorry/index', 'https://www.google.com/search?q=a'), null, 'same host as asked')
  assert.match(ok('https://evil.example/landing', 'https://www.google.com/search?q=a'), /evil\.example/)
  assert.match(ok('https://evil.example/', 'https://github.com/x'), /not one of the allowed/)
  assert.match(ok('https://www.google.com/url?q=https://evil.example/', 'https://www.google.com/search?q=a'), /redirector/)
  assert.match(ok('chrome://settings', 'https://github.com/'), /not a website/)
  // A host the user confirmed aloud stays open on that host and no other.
  assert.equal(ok('https://exemplo-qualquer.xyz/b', 'https://exemplo-qualquer.xyz/a'), null)
  assert.match(ok('https://other.example/', 'https://exemplo-qualquer.xyz/a'), /other\.example/)
})

test('navigation: look-alike hosts and credentials in the address do not pass', () => {
  withEnv(clean, () => {
    for (const url of [
      'https://wikipedia.org.evil.example/', 'https://evilwikipedia.org/', 'https://github.com.evil.example/',
      'https://www.google.com@evil.example/', 'https://user:pw@github.com/', 'https://evil.example/https://github.com/',
    ]) {
      assert.equal(nav(url).allow, false, url)
      assert.equal(nav(url, true).allow, false, `${url} (writes on, no gate)`)
    }
  })
})

test('navigation: other schemes and odd characters are refused in every mode', () => {
  withEnv(clean, () => {
    for (const url of [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'chrome://settings',
      'chrome-extension://abc/x.html', 'about:blank', 'blob:https://github.com/x', 'view-source:https://github.com/', 'ftp://github.com/',
      'java\tscript:alert(1)', 'https://github.com/a b', ' ', '',
    ]) {
      for (const w of [false, true]) assert.equal(nav(url, w, createGate({ getTurn: () => ({ n: 1, text: '' }) })).allow, false, JSON.stringify(url))
    }
  })
})

test('navigation: more than 200 characters of query plus fragment is refused, even on an allowed host', () => {
  withEnv(clean, () => {
    const q = (n) => `https://www.google.com/search?q=${'a'.repeat(n)}`
    assert.equal(nav(q(150)).allow, true)
    assert.equal(nav(q(190)).allow, true) // "?q=" + 190 = 193
    assert.equal(nav(q(198)).allow, false) // 3 + 198 = 201
    assert.equal(nav(`https://github.com/x#${'f'.repeat(250)}`).allow, false)
    assert.equal(nav(`https://github.com/x?a=${'b'.repeat(100)}#${'f'.repeat(100)}`).allow, false)
    assert.equal(nav(q(400), true).allow, false)
    // Data hidden in the path of an unlisted host is no better.
    assert.equal(nav(`https://exemplo-qualquer.xyz/?d=${'z'.repeat(300)}`, true).allow, false)
  })
})

test('navigation: an unlisted host is refused in read-only mode', () => {
  withEnv(clean, () => {
    const r = nav('exemplo-qualquer.xyz')
    assert.equal(r.allow, false)
    assert.match(r.reason, /exemplo-qualquer\.xyz/)
    assert.match(r.reason, /read-only/)
  })
})

test('navigation: with writes on, an unlisted host needs the spoken phrase in the utterance right after the bridge announced it', () => {
  withEnv(clean, () => {
    const turn = { n: 1, text: 'abra o site exemplo-qualquer.xyz', spoken: '' }
    const gate = createGate({ getTurn: () => turn })
    const url = 'https://exemplo-qualquer.xyz/pagina'
    // First call proposes and is refused, with instructions not to ask anything itself.
    const first = nav(url, true, gate)
    assert.equal(first.allow, false)
    assert.match(first.reason, /announce/)
    assert.match(first.reason, /Do not say the address/)
    // Retrying in the same turn does not help, however it is worded.
    turn.text = 'pode abrir'
    assert.equal(nav(url, true, gate).allow, false)
    // The bridge announces it when the turn ends.
    gate.present(1)
    // A bare "sim" is not the phrase.
    turn.n++
    turn.text = 'sim'
    assert.equal(nav(url, true, gate).allow, false)
    // And that was the one utterance that could have confirmed it: the proposal fell.
    turn.n++
    turn.text = 'pode abrir'
    assert.equal(nav(url, true, gate).allow, false)
    // Proposed again, announced, and answered right away: opens, once.
    assert.equal(nav(url, true, gate).allow, false)
    gate.present(turn.n)
    turn.n++
    turn.text = 'pode abrir'
    assert.equal(nav(url, true, gate).allow, true)
    assert.equal(nav(url, true, gate).allow, false, 'the confirmation was spent')
  })
})

test('navigation: a confirmation for one site does not open another', () => {
  withEnv(clean, () => {
    const turn = { n: 1, text: 'abra a', spoken: '' }
    const gate = createGate({ getTurn: () => turn })
    assert.equal(nav('https://a.example/', true, gate).allow, false)
    gate.present(1)
    turn.n++
    turn.text = 'pode abrir'
    assert.equal(nav('https://b.example/', true, gate).allow, false)
    // b was proposed in turn 2 and replaced a: one pending per kind.
    assert.equal(nav('https://a.example/', true, gate).allow, false)
  })
})

test('JARVIS_NAV_ALLOW replaces the default list; "=" means that exact host', () => {
  withEnv({ ...clean, JARVIS_NAV_ALLOW: 'example.org, =only.example.net, =paths.example.net/docs, =front.example.net/' }, () => {
    assert.equal(nav('https://sub.example.org/').allow, true)
    assert.equal(nav('https://only.example.net/').allow, true)
    assert.equal(nav('https://x.only.example.net/').allow, false)
    assert.equal(nav('https://paths.example.net/docs/a').allow, true)
    assert.equal(nav('https://paths.example.net/other').allow, false)
    assert.equal(nav('https://paths.example.net/docsx').allow, false)
    assert.equal(nav('https://front.example.net/').allow, true)
    assert.equal(nav('https://front.example.net/x').allow, false)
    assert.equal(nav('https://github.com/').allow, false, 'the default list is gone')
  })
  withEnv({ ...clean, JARVIS_NAV_ALLOW: '' }, () => {
    assert.equal(nav('https://github.com/').allow, false)
    assert.equal(nav('back').allow, true)
  })
})

test('only chrome_navigate is subject to the navigation rules', () => {
  assert.equal(NAVIGATE_TOOL, NAV)
  assert.equal(checkToolUse('mcp__jarvis_chrome__chrome_read_page', { url: 'javascript:1' }, ctx(false)).allow, true)
  assert.equal(navigationVerdict('https://pt.wikipedia.org/', {}).allow, true)
})

// ------------------------------------------------------------------- L1: Magnific

test('L1: Magnific is blocked in any spelling, on any server name, with writes on or off', () => {
  withEnv(clean, () => {
    for (const name of [
      'mcp__claude_ai_Magnific__images_generate', 'mcp__claude_ai_magnific__images_generate', 'mcp__claude.ai Magnific__account_balance',
      'mcp__magnific__generate', 'mcp__Magnific__x', 'mcp__claude-ai Magnific__x', 'mcp__claude_ai_Magnific_x__a',
      'mcp__some_server__magnific_upscale', 'mcp__claude ai Magnific__images_generate',
    ]) {
      for (const w of [false, true]) {
        assert.equal(decideTool(name, w), false, `${name} writes=${w}`)
        assert.equal(checkToolUse(name, {}, ctx(w)).allow, false, `${name} (checkToolUse, writes=${w})`)
      }
    }
  })
})

test('L1: JARVIS_BLOCKED_SERVERS adds to the default instead of replacing it', () => {
  withEnv({ ...clean, JARVIS_BLOCKED_SERVERS: 'claude_ai_Notion' }, () => {
    assert.equal(serverRefusal('claude_ai_Magnific'), 'blocked', 'the built-in block survives')
    assert.equal(serverRefusal('claude_ai_Notion'), 'blocked')
    assert.equal(decideTool('mcp__claude_ai_Magnific__images_generate', true), false)
  })
  withEnv({ ...clean, JARVIS_BLOCKED_SERVERS: '' }, () => {
    assert.equal(serverRefusal('claude_ai_Magnific'), 'blocked', 'an empty variable does not unblock it')
  })
})

test('L1: an account connector with a dot or space in its name is still an account connector', () => {
  withEnv(clean, () => {
    assert.equal(decideTool('mcp__claude.ai Gmail__search_threads', false), true, 'listed, however spelled')
    assert.equal(decideTool('mcp__claude.ai Slack__send_message', true), false, 'unlisted, however spelled')
    assert.equal(decideTool('mcp__claude ai Notion__search', true), false)
    assert.equal(serverRefusal('claude.ai Slack'), 'unlisted')
    assert.equal(serverRefusal('claude-ai Gmail'), null)
  })
})

// ------------------------------------------------- M5: keys and typing around navigation

test('M5: chrome_key cannot reach the address bar or the browser\'s own shortcuts', () => {
  for (const chord of ['ctrl+l', 'Ctrl+L', 'cmd+l', 'control+l', 'meta+l', 'alt+d', 'F6', 'f12', 'ctrl+k', 'ctrl+t', 'ctrl+n', 'ctrl+shift+n', 'ctrl+o', 'ctrl+shift+i', 'cmd+alt+i', 'ctrl+u', 'ctrl+shift+delete', 'ctrl+a ctrl+l', 'Escape ctrl+l']) {
    assert.notEqual(keyProblem(chord), null, chord)
    assert.equal(allowed(NAV.replace('navigate', 'key'), { text: chord }, true), false, chord)
  }
  for (const chord of ['Return', 'Escape', 'Tab', 'ctrl+a', 'ctrl+c', 'ctrl+v', 'cmd+a', 'ArrowDown', 'shift+Tab', 'l', 'ctrl+a Return', 'space']) {
    assert.equal(keyProblem(chord), null, chord)
  }
})

test('M5: chrome_type refuses what looks like an address; ordinary text types', () => {
  for (const text of ['https://evil.example/?d=secret', 'evil.example.com', 'www.evil.example/x', 'evil.xyz/path?d=1', 'javascript:alert(1)', 'data:text/html,hi', 'github.com/anthropics', 'ftp://x.y/z', 'ir para www.evil.example', 'evil.com?d=x', 'att.museum/x', '//att.example/x', 'https：//att.example', 'ana.souza']) {
    assert.notEqual(typeProblem(text), null, text)
    assert.equal(allowed(NAV.replace('navigate', 'type'), { text }, true), false, text)
  }
  // With writes on the text is also read out and has to be confirmed (N6), so "ordinary" here
  // means: typeProblem has nothing against it. A bare "name.surname" reads as a host and is refused.
  for (const text of ['gatos fofos', 'Maria Silva', 'joao.silva@exemplo.com', 'Qual a previsão do tempo?', '42']) {
    assert.equal(typeProblem(text), null, text)
    assert.equal(checkToolUse(NAV.replace('navigate', 'type'), { text }, { ...ctx(true) }).allow, false, `${text}: needs the spoken confirmation first`)
  }
})
