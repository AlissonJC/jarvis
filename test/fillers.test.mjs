import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allLines, forTool, working, acknowledge, attention } from '../src/lib/fillers.ts'

test('every filler line is Portuguese, short, and unchanged by speech shaping', () => {
  const lines = allLines()
  assert.ok(lines.length >= 20)
  for (const line of lines) {
    assert.ok(line.trim() === line && line.length > 2, `linha vazia ou com espaços: "${line}"`)
    assert.ok(line.split(/\s+/).length <= 6, `longa demais: ${line}`)
    assert.ok(!/\b(sir|the|you|your|working|searching|checking)\b/i.test(line), `inglês: ${line}`)
    assert.ok(!/!/.test(line), `exclamação: ${line}`)
    // shape() inserts a comma before a trailing "senhor"; lines already have it,
    // otherwise the audio cache would be keyed under different text.
    assert.ok(!/[^,\s]\s+senhor\s*[.?!]?$/i.test(line), `falta a vírgula antes de senhor: ${line}`)
  }
})

test('pickers and tool matching still work', () => {
  assert.ok(working() && acknowledge() && attention())
  assert.ok(allLines().includes(forTool('mcp__gmail__search_inbox')))
  assert.ok(allLines().includes(forTool('Bash')))
})
