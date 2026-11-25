import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, isAbsolute } from 'node:path'

/**
 * Folders the assistant keeps for itself (its workspace, temporary files, state,
 * the spoken-sentence cache) hold what the user said and what the agent read, so
 * they are for the user alone: mode 700. `mkdirSync(dir, { recursive: true })`
 * on its own leaves 775 under a common umask, which is how `~/.jarvis/workspace`
 * ended up readable by the whole group (docs/REVISAO-SEGURANCA-2.md, N10c).
 *
 * New folders are created 700. A folder that already exists is tightened only if
 * it sits under one of the assistant's own roots and belongs to this user:
 * `JARVIS_WORKSPACE=$HOME` must not turn the home directory private behind the
 * user's back.
 */
const OWN_ROOTS = (home) => [join(home, '.jarvis'), join(home, '.cache', 'jarvis')]

const inside = (root, p) => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Creates `dir` (and its parents) with mode 700; returns the resolved path. Never throws on the chmod. */
export function ensurePrivateDir(dir, { home = homedir() } = {}) {
  const path = resolve(dir)
  const existed = existsSync(path)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const own = OWN_ROOTS(home).some((root) => inside(root, path))
  if (!existed || own) {
    try {
      const info = statSync(path)
      const mine = typeof process.getuid !== 'function' || info.uid === process.getuid()
      if (mine && (info.mode & 0o077) !== 0) chmodSync(path, 0o700)
    } catch {
      /* the folder is usable either way; this is hardening */
    }
  }
  // The roots themselves: a deep path created in one go gets 700 from mkdir, but
  // an older ~/.jarvis may predate that.
  for (const root of OWN_ROOTS(home)) {
    if (path !== root && inside(root, path) && existsSync(root)) {
      try {
        const info = statSync(root)
        const mine = typeof process.getuid !== 'function' || info.uid === process.getuid()
        if (mine && (info.mode & 0o077) !== 0) chmodSync(root, 0o700)
      } catch {
        /* as above */
      }
    }
  }
  return path
}
