// M3: where the tab ends up is checked after the page loads, and a redirect to
// somewhere that was not allowed is undone. Runs against a fake browser; never
// touches a real one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromeTools, link } from '../bridge/chrome.mjs'
import { navigationFinalProblem } from '../bridge/policy.mjs'

/** A browser whose first navigation lands on `landsOn`, and which records everything asked of it. */
function fakeBrowser(landsOn) {
  const calls = []
  let current = 'about:blank'
  link.call = async (name, args) => {
    calls.push([name, args])
    const text = (t) => ({ result: { content: [{ type: 'text', text: t }] } })
    if (name === 'tabs_context_mcp') return text(JSON.stringify({ availableTabs: [{ tabId: 4242 }] }))
    if (name === 'navigate') {
      if (args.url === 'back') current = 'https://github.com/previous'
      else current = landsOn
      return text(`Navigated to ${args.url}`)
    }
    if (name === 'get_page_text') return text(`URL: ${current}\nTitle: x\n\nhello`)
    return text('ok')
  }
  return calls
}

const navigate = (finalProblem) =>
  chromeTools({ allowWrites: false, finalProblem }).find((t) => t.name === 'chrome_navigate').handler

test('M3: a listed site that forwards to an unlisted one is sent back, and the model is told', async () => {
  const calls = fakeBrowser('https://evil.example/landing?d=1')
  const handler = navigate((landed, asked) => navigationFinalProblem(landed, asked))
  const out = await handler({ url: 'https://www.google.com/search?q=gatos' }, {})
  assert.equal(out.isError, true)
  assert.match(out.content[0].text, /not kept open/)
  assert.match(out.content[0].text, /evil\.example/)
  const navs = calls.filter(([n]) => n === 'navigate').map(([, a]) => a.url)
  assert.deepEqual(navs, ['https://www.google.com/search?q=gatos', 'back'], 'it went to the page, saw where it landed, and went back')
})

test('M3: a normal navigation that stays on its site is returned as it was', async () => {
  const calls = fakeBrowser('https://github.com/anthropics')
  const handler = navigate((landed, asked) => navigationFinalProblem(landed, asked))
  const out = await handler({ url: 'https://github.com/anthropics' }, {})
  assert.notEqual(out.isError, true)
  assert.deepEqual(calls.filter(([n]) => n === 'navigate').map(([, a]) => a.url), ['https://github.com/anthropics'])
})

test('M3: a scheme-less address is judged too (it used to skip the wait entirely)', async () => {
  fakeBrowser('https://evil.example/')
  const handler = navigate((landed, asked) => navigationFinalProblem(landed, asked))
  const out = await handler({ url: 'www.wikipedia.org' }, {})
  assert.equal(out.isError, true)
})

test('M3: back and forward are not judged', async () => {
  const calls = fakeBrowser('https://evil.example/')
  let judged = 0
  const handler = navigate(() => (judged++, 'no'))
  const out = await handler({ url: 'back' }, {})
  assert.notEqual(out.isError, true)
  assert.equal(judged, 0)
  assert.equal(calls.filter(([n]) => n === 'navigate').length, 1)
})
