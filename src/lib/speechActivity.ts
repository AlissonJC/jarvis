/**
 * Is he speaking, as far as "do not let a sound from my own speakers wake me"
 * is concerned?
 *
 * The text being played is not enough. Between two queued sentences it is empty
 * for a moment — the first one has finished, the next has not started — and in
 * that gap the clap wake used to be protected only by its 300 ms grace. So
 * this counts the sentences that are still owed (queued, being synthesised or
 * playing) as well: he is "speaking" until the last of them is done, and
 * `endedAt` is when that happened, not when the first sentence ended.
 *
 * Pure, with an injectable clock, so it can be tested without a browser.
 */
export function createSpeechActivity(clock: () => number = Date.now) {
  let text = ''
  let owed = 0
  let endedAt = 0
  let wasBusy = false

  const sync = () => {
    const busy = text !== '' || owed > 0
    if (wasBusy && !busy) endedAt = clock()
    wasBusy = busy
  }

  return {
    /** The sentence being played right now, or '' for none. */
    setText(next: string) {
      text = next
      sync()
    },
    /** A sentence was queued. */
    owe() {
      owed++
      sync()
    },
    /** A queued sentence finished, or was dropped. */
    settle(count = 1) {
      owed = Math.max(0, owed - count)
      sync()
    },
    state(): { speaking: boolean; endedAt: number } {
      return { speaking: text !== '' || owed > 0, endedAt }
    },
  }
}
