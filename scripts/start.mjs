/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`.
 *
 * Pass --built to serve the BUILT face (`npm run build` first) with
 * scripts/serve.mjs instead of the Vite dev server. That is how it should run
 * day to day (docs/SEGURANCA.md): no dev server, no hot-reload socket, the CSP
 * without 'unsafe-inline', and the per-start token handed over by a route of the
 * static server instead of being inlined into a module a dev server serves.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { faceEnv } from '../bridge/env.mjs'

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/**
 * Make `to` hold exactly the files of `from`, byte for byte.
 *
 * Copying only "if the file is missing" meant a runtime that was upgraded in
 * node_modules left the old WASM in public/, and the page then loaded a script
 * and a binary from two different releases, which fails in ways that look like
 * a broken model. Each file is compared by SHA-256 against the copy that the
 * lockfile pins, and copied again when it differs (or when it is missing, or
 * has been altered). Returns the number of files written.
 */
function syncDir(from, to) {
  mkdirSync(to, { recursive: true })
  let written = 0
  for (const name of readdirSync(from)) {
    const src = join(from, name)
    if (!statSync(src).isFile()) continue
    const dst = join(to, name)
    if (!existsSync(dst) || sha256Of(dst) !== sha256Of(src)) {
      copyFileSync(src, dst)
      written++
    }
  }
  return written
}

/**
 * A model that is downloaded once, pinned by SHA-256, and served from this
 * origin. An existing file is only trusted if it is the reviewed one; a partial
 * download, a corrupted disk or a swapped file is deleted and fetched again.
 * Throws if the download is not the pinned bytes. Returns true if it fetched.
 */
async function vendorPinned({ url, sha256, file, label }) {
  if (existsSync(file)) {
    if (sha256Of(file) === sha256) return false
    console.warn(`  the ${label} on disk does not match its checksum; fetching it again.`)
    rmSync(file, { force: true })
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const sum = createHash('sha256').update(bytes).digest('hex')
  if (sum !== sha256) throw new Error(`unexpected checksum ${sum}`)
  mkdirSync('public/models', { recursive: true })
  writeFileSync(`${file}.part`, bytes)
  renameSync(`${file}.part`, file)
  console.log(`  downloaded the ${label} into public/models.`)
  return true
}

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run. Each file is checked against the one in node_modules (see
 * syncDir), so an upgrade or a damaged copy is put right on the next start.
 */
async function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  try {
    const n = syncDir(from, to)
    if (n) console.log(`  vendored the hand-tracking runtime into public/mediapipe (${n} file${n === 1 ? '' : 's'}).`)
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
  // The hand model, same rules as the sound model below: pinned by checksum, served
  // from here, so the page needs no connection to a model host.
  try {
    await vendorPinned({ url: HAND_URL, sha256: HAND_SHA256, file: 'public/models/hand_landmarker.task', label: 'hand-tracking model' })
  } catch (err) {
    console.warn(`  could not set up the hand model (gestures stay off, voice is unaffected): ${err.message}`)
  }
}

/**
 * The same, for the clap/snap wake (see src/lib/clapwake.ts): MediaPipe's audio
 * runtime, copied next to the vision one (the file names do not collide), and
 * the YAMNet sound-classifier model, downloaded once and pinned by SHA-256 so
 * what the page loads is exactly the file that was reviewed. Served from our own
 * origin at run time: no CDN. Optional like gesture control: if anything here
 * fails the clap wake simply does not start, and the voice wake word is
 * unaffected.
 */
const YAMNET_URL =
  'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite'
const YAMNET_SHA256 = '4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf'

// The hand-landmark model src/lib/hands.ts loads. It used to be fetched from the
// host below on every first use, which is why the page's CSP had to allow it;
// now it is downloaded here once, checked against this hash (the file Google's
// bucket has served since 2023, generation 1682480004222387), and the page asks
// only its own origin.
const HAND_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const HAND_SHA256 = 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1'

async function vendorClapModel() {
  const from = 'node_modules/@mediapipe/tasks-audio/wasm'
  const to = 'public/mediapipe'
  try {
    if (existsSync(from)) {
      const n = syncDir(from, to)
      if (n) console.log(`  vendored the sound-classifier runtime into public/mediapipe (${n} file${n === 1 ? '' : 's'}).`)
    }
    await vendorPinned({ url: YAMNET_URL, sha256: YAMNET_SHA256, file: 'public/models/yamnet.tflite', label: 'YAMNet sound model' })
  } catch (err) {
    console.warn(`  could not set up the clap wake (voice wake is unaffected): ${err.message}`)
  }
}

const writes = process.argv.includes('--writes')

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = []

function run(name, command, args, colour, env, base = process.env) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...base, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code) => {
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Pick the face's port here, and tell the bridge exactly which origin that is.
 *
 * The bridge accepts the face from one origin, the one named here, not from a
 * range of ports (docs/REVISAO-SEGURANCA-2.md, N8): any other dev server a
 * student runs on a nearby port must not be able to drive the agent. So the
 * launcher has to know the port before either half starts, and Vite is told to
 * keep it (`strictPort`) rather than quietly move to the next free one, which
 * would leave the interface loading with the brain answering nothing, because
 * the handshake is being 403'd somewhere neither half reports.
 *
 * PORT, if set, is used as it is; otherwise the first free port from 5173 (4173
 * for the built face, where `vite preview` starts).
 */
const built = process.argv.includes('--built')

function isFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function pickPort(first) {
  for (let p = first; p < first + 40; p++) if (await isFree(p)) return p
  throw new Error(`no free port from ${first} to ${first + 39}`)
}

const port = Number(process.env.PORT) || (await pickPort(built ? 4173 : 5173))

/**
 * One token per start, given to both halves (see the L4 notes in
 * bridge/server.mjs): the bridge asks for it on its socket and on /file, /img,
 * /media and /page, and the face sends it. A token already in the environment is
 * used as it is. It is not a secret from the user's own browser, which is handed
 * it by Vite; it keeps out other sites and other local programs.
 */
const bridgeToken = process.env.JARVIS_BRIDGE_TOKEN?.trim() || randomBytes(24).toString('base64url')
const bridgeEnv = {
  JARVIS_BRIDGE_TOKEN: bridgeToken,
  JARVIS_FACE_ORIGIN: `http://localhost:${port},http://127.0.0.1:${port}`,
  ...(writes ? { JARVIS_ALLOW_WRITES: '1' } : {}),
}
console.log(`  serving the ${built ? 'built ' : ''}face on port ${port}; the bridge will accept that origin only.\n`)

await vendorWasm()
await vendorClapModel()

console.log('\nJ.A.R.V.I.S. starting — the brain and the face.\n')
run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
// The face is a build tool serving files to a browser; it has no use for the
// bridge's keys, so it does not inherit them (faceEnv is an allowlist).
if (built) {
  if (!existsSync('dist/index.html')) {
    console.error('  dist/ is missing: run `npm run build` first (or start without --built).')
    process.exit(1)
  }
  run('face', process.execPath, ['scripts/serve.mjs'], '35', { JARVIS_BRIDGE_TOKEN: bridgeToken, PORT: String(port) }, faceEnv(process.env))
  console.log(`\nOpen http://localhost:${port}/ in Chrome, click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n`)
} else {
  run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', { VITE_BRIDGE_TOKEN: bridgeToken, PORT: String(port) }, faceEnv(process.env))
  console.log(
    '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
      'click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n',
  )
}
