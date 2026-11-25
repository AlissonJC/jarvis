import type { Blade, Phase } from '../store'

/**
 * The assistant speaking first: the face's side of the announce channel
 * (bridge/proactive.mjs). Pure logic only; the sockets are in bridge.ts and
 * the speaking in App.tsx.
 *
 * An announcement is words to be spoken and shown. It is never sent to the
 * model and never answers a question, so it plays exactly like an answer does
 * as far as the microphone is concerned (it goes through the same speaker),
 * and it waits for a moment when nobody is in the middle of a sentence.
 */

export type Announcement = {
  id: string
  text: string
  priority: 'normal' | 'high'
  source: string
  kind: string
  /** When the bridge queued it, ms since the epoch. */
  at: number
  expiresAt: number
}

/** A frame from the bridge, checked. Anything malformed is dropped, not guessed at. */
export function parseAnnouncement(frame: unknown): Announcement | null {
  if (!frame || typeof frame !== 'object') return null
  const f = frame as Record<string, unknown>
  if (typeof f.id !== 'string' || !/^[a-z0-9]{4,32}$/.test(f.id)) return null
  if (typeof f.text !== 'string' || !f.text.trim() || f.text.length > 1500) return null
  return {
    id: f.id,
    text: f.text.trim(),
    priority: f.priority === 'high' ? 'high' : 'normal',
    source: typeof f.source === 'string' ? f.source.slice(0, 24) : 'local',
    kind: typeof f.kind === 'string' ? f.kind.slice(0, 16) : 'announce',
    at: Number.isFinite(f.at) ? Number(f.at) : 0,
    expiresAt: Number.isFinite(f.expiresAt) ? Number(f.expiresAt) : Number.MAX_SAFE_INTEGER,
  }
}

/** How long a "high" announcement waits through a conversation before it may speak at an open mic. */
export const HIGH_WAITS_LISTENING_MS = 20_000
/** How long to hold off for a loud room before speaking anyway. */
export const LOUD_ROOM_MS = 10_000

/**
 * May this announcement start speaking now?
 *
 * Only when the assistant is at rest (`dormant`). While he is thinking, working
 * or speaking, or waiting for the user's sentence (`waking`), it waits. A
 * `high` one (a reminder) may also speak into the follow-up window
 * (`listening`) after 20 s of waiting, if nothing of a sentence is on screen.
 * A loud microphone delays any of them by up to ten seconds.
 */
export function canPlayNow(opts: {
  phase: Phase
  /** What the user is saying right now ('' when nothing is being transcribed). */
  caption: string
  priority: 'normal' | 'high'
  waitedMs: number
  micLoud: boolean
}): boolean {
  const { phase, caption, priority, waitedMs, micLoud } = opts
  if (micLoud && waitedMs < LOUD_ROOM_MS) return false
  if (phase === 'dormant') return true
  if (phase === 'listening') return priority === 'high' && waitedMs >= HIGH_WAITS_LISTENING_MS && caption.trim() === ''
  return false
}

/** Announcements that arrived and have not been spoken, and the ones already dealt with. */
export function createAnnounceInbox(now: () => number = Date.now) {
  const waiting = new Map<string, { item: Announcement; receivedAt: number }>()
  const seen: string[] = []
  const remember = (id: string) => {
    seen.push(id)
    if (seen.length > 200) seen.shift()
  }

  return {
    /** False if it was already received (a re-send), already spoken, or already out of date. */
    add(item: Announcement): boolean {
      if (waiting.has(item.id) || seen.includes(item.id) || item.expiresAt <= now()) return false
      waiting.set(item.id, { item, receivedAt: now() })
      return true
    },
    /** The next to speak: high before normal, then the oldest. Expired ones are dropped on the way. */
    next(): { item: Announcement; waitedMs: number } | null {
      for (const [id, w] of waiting) {
        if (w.item.expiresAt <= now()) {
          waiting.delete(id)
          remember(id)
        }
      }
      const all = [...waiting.values()].sort(
        (a, b) =>
          (a.item.priority === 'high' ? 0 : 1) - (b.item.priority === 'high' ? 0 : 1) || a.receivedAt - b.receivedAt,
      )
      const head = all[0]
      return head ? { item: head.item, waitedMs: now() - head.receivedAt } : null
    },
    /** Spoken, cut off for good, or refused: it will not be offered again by this page. */
    done(id: string) {
      waiting.delete(id)
      remember(id)
    },
    /** Cut off and to be tried again later by the bridge: forget it here so the re-send is accepted. */
    release(id: string) {
      waiting.delete(id)
    },
    get size() {
      return waiting.size
    },
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const LABEL: Record<string, string> = { reminder: 'LEMBRETE', briefing: 'RESUMO DA MANHÃ', announce: 'AVISO' }

/** The HUD card shown while it is spoken: the whole text, and where it came from. */
export function announceBlade(a: Announcement): Blade {
  const label = LABEL[a.kind] ?? 'AVISO'
  const from = a.kind === 'announce' && a.source !== 'local' ? `Origem: ${a.source}` : 'Aviso do assistente'
  return {
    id: `announce-${a.id}`,
    title: label,
    kind: 'markup',
    html:
      `<div class="hud-rows"><div class="hud-row"><div class="hud-main"><div class="hud-label">${esc(from)}</div>` +
      `<div class="hud-sub">${esc(a.text)}</div></div><div class="hud-tag">${esc(label)}</div></div></div>`,
    size: 'compact',
    hold: 'turn',
  }
}
