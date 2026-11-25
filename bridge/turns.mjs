/**
 * The user's side of a conversation, one turn at a time.
 *
 * The SDK reads the input generator as fast as it yields, so handing it each
 * utterance the moment it arrives starts a new turn on top of the one still
 * running, and `turn.n` — which the confirmation gate (confirm.mjs) trusts to
 * mean "the utterance the user is answering with" — moves while the first turn
 * is still calling tools. A page that had talked the model into proposing and
 * confirming a message in a loop could then be handed a "sim" the user said to
 * something else (docs/REVISAO-SEGURANCA-F4.md, M2).
 *
 * So an utterance is only counted, and only handed to the model, once the turn
 * before it has produced its `result` (the caller reports that with `end()`).
 * Until then it waits here.
 *
 * The cap exists to break a wedge, never to be reached, and what it does matters
 * (docs/REVISAO-SEGURANCA-2.md, N5). It used to give up on the old turn and start
 * the next one anyway, which left the SDK still running the old turn while
 * `turn.n` counted the new one: the old turn's late tool calls were then judged
 * against an utterance that was said to something else, and the old turn's own
 * `result` released the new one. Now, at the cap, the turn is told to stop
 * (`onCap`: the caller interrupts the session) and the wait goes on for its
 * `result`. Only if even that never comes (`graceMs` later) is the conversation
 * given up (`onStuck`: the caller closes the socket, so the face reconnects to a
 * clean session). `turn.n` never moves while an earlier turn may still be alive.
 */

/**
 * `decorate` is what the MODEL is handed for an utterance (the bridge's clock in
 * front of it, docs/SEGURANCA.md O1); `turn.text`, which the confirmation gate and
 * the reminder and memory tools compare against, stays the user's words alone.
 *
 * @param {{
 *   turn: { n: number, text: string },
 *   onBegin?: (item: { text: string, id: string | null }) => void,
 *   onCap?: () => void,
 *   onStuck?: () => void,
 *   decorate?: (text: string) => string,
 *   capMs?: number,
 *   graceMs?: number,
 * }} opts  `turn` is mutated: `n` and `text` change only when a turn begins.
 */
export function createTurnInput({
  turn,
  onBegin = () => {},
  onCap = () => {},
  onStuck = () => {},
  decorate = (text) => text,
  capMs = 10 * 60_000,
  graceMs = 30_000,
}) {
  const inbox = []
  let waiting = null
  let closed = false
  /** Resolves when the running turn is over; null when nothing is running. */
  let open = null
  let finish = null

  /** Waits up to `ms` for `running` (the promise of a turn in flight) to resolve; true if it did. */
  const endsWithin = async (running, ms) => {
    let timer
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
    })
    try {
      return await Promise.race([running.then(() => true), timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  async function* messages() {
    while (!closed) {
      const item = inbox.length
        ? inbox.shift()
        : await new Promise((resolve) => {
            waiting = resolve
          })
      if (closed || item == null) return
      if (open) {
        const running = open
        if (!(await endsWithin(running, capMs))) {
          // Ask it to stop, and keep waiting for it to say it has.
          onCap()
          if (!(await endsWithin(running, graceMs))) {
            closed = true
            onStuck()
            return
          }
        }
        if (closed) return
      }
      turn.n++
      turn.text = item.text
      onBegin(item)
      open = new Promise((resolve) => {
        finish = resolve
      })
      yield {
        type: 'user',
        message: { role: 'user', content: decorate(item.text) },
        parent_tool_use_id: null,
      }
    }
  }

  return {
    messages,
    /** An utterance from the user. It is queued behind the turn in flight. */
    push(item) {
      if (closed) return
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve(item)
      } else {
        inbox.push(item)
      }
    },
    /** The turn in flight has produced its result. */
    end() {
      finish?.()
      finish = null
      open = null
    },
    /** The conversation is over; unblocks the generator. */
    close() {
      closed = true
      waiting?.(null)
      finish?.()
    },
    get running() {
      return open !== null
    },
  }
}
