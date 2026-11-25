import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitFirstClause } from '../src/lib/chunking.ts'

test('splits at the first comma that leaves 6-10 words before it', () => {
  const s = 'De acordo com a agenda de hoje, o senhor tem três reuniões marcadas para esta tarde.'
  assert.deepEqual(splitFirstClause(s), [
    'De acordo com a agenda de hoje,',
    'o senhor tem três reuniões marcadas para esta tarde.',
  ])
})

test('skips a comma that comes too early and takes a later one', () => {
  const s = 'Receio que, no momento, a previsão para amanhã, em São Paulo, indique chuva forte durante toda a manhã.'
  const parts = splitFirstClause(s)
  assert.ok(parts)
  assert.equal(parts[0], 'Receio que, no momento, a previsão para amanhã,')
})

test('leaves a short sentence whole', () => {
  assert.equal(splitFirstClause('Claro, senhor, são quatro e meia da tarde.'), null)
  assert.equal(splitFirstClause('Não encontrei nada sobre isso.'), null)
})

test('does not cut when the rest would be a stub', () => {
  assert.equal(splitFirstClause('A reunião com o time de produto começa às três, senhor.'), null)
})

test('does not cut when the first comma is already past 10 words', () => {
  const s = 'Uma frase longa demais para caber num único trecho curto de fala, e que ainda continua por bastante tempo.'
  assert.equal(splitFirstClause(s), null)
})

test('does not split inside a number', () => {
  assert.equal(splitFirstClause('O total chegou a 1,5 milhão de reais neste trimestre fiscal inteiro e subiu'), null)
})
