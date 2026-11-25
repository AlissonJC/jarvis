import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { safeEnv } from '../bridge/env.mjs'

const parent = {
  PATH: '/usr/bin:/bin', HOME: '/home/u', LANG: 'pt_BR.UTF-8', TMPDIR: '/tmp', USER: 'u', XDG_RUNTIME_DIR: '/run/user/1000',
  OPENJARVIS_API_KEY: 'oj-secret-1', OPENJARVIS_URL: 'http://127.0.0.1:8000', ELEVENLABS_API_KEY: 'el-secret-2',
  JARVIS_BRIDGE_TOKEN: 'bridge-token-3', VITE_BRIDGE_TOKEN: 'bridge-token-3',
  GITHUB_TOKEN: 'gh-4', NPM_TOKEN: 'npm-5', AWS_SECRET_ACCESS_KEY: 'aws-6', DATABASE_PASSWORD: 'pw-7', SOME_API_KEY: 'k-8', SUPABASE_SERVICE_KEY: 's-9',
  SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh', MY_PRIVATE_THING: 'p-10', SESSION_COOKIE: 'c-11',
  ANTHROPIC_API_KEY: 'sk-ant-needed-by-the-cli', ANTHROPIC_AUTH_TOKEN: 'a-12', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-13', CLAUDE_CONFIG_DIR: '/x',
  JARVIS_MODEL: 'claude-opus-5', JARVIS_NAME: 'Jarvis', KEYBOARD_LAYOUT: 'br', GNOME_KEYRING_CONTROL: '/run/x',
}

test('M5: the agent does not inherit the credentials the bridge holds', () => {
  const env = safeEnv(parent, { TMPDIR: '/home/u/.jarvis/tmp' })
  for (const name of [
    'OPENJARVIS_API_KEY', 'ELEVENLABS_API_KEY', 'JARVIS_BRIDGE_TOKEN', 'VITE_BRIDGE_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY',
    'DATABASE_PASSWORD', 'SOME_API_KEY', 'SUPABASE_SERVICE_KEY', 'SSH_AUTH_SOCK', 'MY_PRIVATE_THING', 'SESSION_COOKIE',
  ]) {
    assert.ok(!(name in env), `${name} must not reach the agent`)
  }
  const joined = JSON.stringify(env)
  for (const secret of ['oj-secret-1', 'el-secret-2', 'bridge-token-3', 'gh-4', 'npm-5', 'aws-6', 'pw-7']) assert.ok(!joined.includes(secret), secret)
})

test('M5/N7: what the CLI needs to start and run stays, and the agent\'s temp directory is its own', () => {
  const env = safeEnv(parent, { TMPDIR: '/home/u/.jarvis/tmp', CLAUDE_CODE_TMPDIR: '/home/u/.jarvis/tmp' })
  for (const name of ['PATH', 'HOME', 'LANG', 'USER', 'CLAUDE_CONFIG_DIR']) {
    assert.ok(name in env, `${name} should stay`)
  }
  // An allowlist: the rest of the machine's environment stays out, including what looks harmless
  // (the desktop keyring, the runtime directory with the session bus) and the bridge's own settings.
  for (const name of ['XDG_RUNTIME_DIR', 'OPENJARVIS_URL', 'JARVIS_MODEL', 'JARVIS_NAME', 'KEYBOARD_LAYOUT', 'GNOME_KEYRING_CONTROL']) {
    assert.ok(!(name in env), `${name} must not reach the agent`)
  }
  // The CLI's own login variables are kept: it cannot start without them. Documented as a reason never to run writes on an open mic.
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-needed-by-the-cli')
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-13')
  assert.equal(env.TMPDIR, '/home/u/.jarvis/tmp')
  assert.equal(env.CLAUDE_CODE_TMPDIR, '/home/u/.jarvis/tmp')
})

test('M5: printenv in a child started with the filtered environment shows no bridge secret', () => {
  const out = execFileSync('/usr/bin/printenv', [], { env: safeEnv({ ...process.env, ...parent, PATH: '/usr/bin:/bin' }) }).toString()
  for (const secret of ['oj-secret-1', 'el-secret-2', 'bridge-token-3']) assert.ok(!out.includes(secret), secret)
  assert.match(out, /PATH=/)
})

test('M5: the filter does not mutate its input or choke on undefined values', () => {
  const input = { A_TOKEN: 'x', B: undefined, HOME: 'y', PATH: undefined }
  const out = safeEnv(input)
  assert.deepEqual(out, { HOME: 'y' })
  assert.equal(input.A_TOKEN, 'x')
})
